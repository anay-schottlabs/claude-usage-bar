import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { AgentRow, AgentStatus, MainRow, Plan, Resume, Task, TaskStatus } from '../types'
import { describeCall } from './format'
import { ctl } from './controllers'
import { queueContext, QUEUE_THRESHOLD } from './instructions'
import { applyCheckpoint, applyPlan, CHECKPOINT_TOOL_FULL, completePlan, planLabel, PLAN_TOOL_FULL } from './progress'

// Each module names the atoms it touches (the scan reads them per module).
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const isBusy = atom({ plugin: 'mission-control', key: 'isBusy' } as const, false)
const resume = atom({ plugin: 'mission-control', key: 'resume' } as const, null as Resume | null, { shape: 'resume-1' })
const tasks = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as Task[], { shape: 'tasks-1' })
const main = atom({ plugin: 'mission-control', key: 'main' } as const, { phase: 'idle', current: '', toolCount: 0 } as MainRow, {
  shape: 'main-1',
})
const queued = atom({ plugin: 'mission-control', key: 'queued' } as const, 0)
const plans = atom({ plugin: 'mission-control', key: 'plans' } as const, {} as Record<string, Plan>, { shape: 'plans-1' })

const MAIN = 'main'
const withPlan = (all: Record<string, Plan>, key: string, plan: Plan | undefined) => {
  const next = { ...all }
  if (plan) next[key] = plan
  else delete next[key]
  return next
}

const isDenied = (out: unknown) =>
  typeof out === 'object' && out !== null && 'deny' in out && (out as { deny?: unknown }).deny !== undefined

const isFinished = (s: AgentStatus) => s !== 'running'

/** A list mapper that patches one agent's row. */
const patchAgent = (id: string, fn: (row: AgentRow) => AgentRow) => (list: AgentRow[]) =>
  list.map(row => (row.id === id ? fn(row) : row))

/** Tasks and agents: mirrors the model's task tools and its subagents into state. */
export const registerTracker = (on: On, afterToolCall?: (tool: string) => void) => {
  // ── Task list ──────────────────────────────────────────────────────────
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const out = await next(e)
    if (isDenied(out) || out.isError) return out
    const created = (out.result as { task?: { id?: string; subject?: string } } | undefined)?.task
    if (created?.id) {
      const task: Task = {
        id: created.id,
        subject: created.subject ?? e.subject,
        activeForm: e.activeForm,
        status: 'pending',
      }
      await update($, tasks, list => [...list.filter(t => t.id !== task.id), task])
    }
    return out
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const out = await next(e)
    if (isDenied(out) || out.isError) return out
    if ((out.result as { success?: boolean } | undefined)?.success === false) return out

    // A subagent that starts an unowned task takes it: its bar counts it.
    let owner = e.owner
    if (owner === undefined && e.agentId !== undefined && e.status === 'in_progress') {
      owner = (await read($, agents)).find(a => a.id === e.agentId)?.name
    }

    await update($, tasks, list => {
      if (e.status === 'deleted') return list.filter(t => t.id !== e.taskId)
      const known = list.some(t => t.id === e.taskId)
      const base: Task = known
        ? list.find(t => t.id === e.taskId)!
        : { id: e.taskId, subject: e.subject ?? `Task ${e.taskId}`, status: 'pending' }
      const merged: Task = {
        ...base,
        ...(e.subject !== undefined && { subject: e.subject }),
        ...(e.activeForm !== undefined && { activeForm: e.activeForm }),
        ...(e.status !== undefined && { status: e.status as TaskStatus }),
        ...(owner !== undefined && base.owner === undefined && { owner }),
        ...(e.owner !== undefined && { owner: e.owner }),
      }
      return known ? list.map(t => (t.id === e.taskId ? merged : t)) : [...list, merged]
    })
    return out
  })

  // Sessions that use the older todo list instead of tasks.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const out = await next(e)
    if (isDenied(out) || out.isError) return out
    await update($, tasks, () =>
      e.todos.map((todo, i) => ({
        id: `todo-${i + 1}`,
        subject: todo.content,
        activeForm: todo.activeForm,
        status: todo.status,
      })),
    )
    return out
  })

  // ── Progress plans: the mod's own tools, answered here ────────────────
  on('tool.call', { tool: 'mcp__mission-control__progress_plan' }, async ($, e) => {
    const key = e.agentId ?? MAIN
    const now = await $.clock.now()
    const all = await update($, plans, list => withPlan(list, key, applyPlan(list[key], e as never, now)))
    const plan = all[key]!
    const secs = plan.checkpoints.reduce((n, c) => n + c.seconds, 0)
    return {
      result: {
        message: `Plan recorded: ${plan.checkpoints.length} checkpoints, about ${Math.round(secs / 60)} min. Call ${CHECKPOINT_TOOL_FULL} as each one is reached.`,
      },
    }
  })

  on('tool.call', { tool: 'mcp__mission-control__progress_checkpoint' }, async ($, e) => {
    const key = e.agentId ?? MAIN
    const now = await $.clock.now()
    const prev = (await read($, plans))[key]
    if (!prev) return { result: { message: `No plan yet: call ${PLAN_TOOL_FULL} first.` } }
    const all = await update($, plans, list => withPlan(list, key, applyCheckpoint(list[key] ?? prev, now)))
    const plan = all[key]!
    return {
      result: {
        message: plan.isComplete ? 'All checkpoints reached.' : `Checkpoint reached (${planLabel(plan)} next).`,
      },
    }
  })

  // The mod's own bookkeeping tools never need the person's approval.
  on('tool.check', { tool: 'mcp__mission-control__progress_plan' }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'mcp__mission-control__progress_checkpoint' }, () => ({ decision: 'allow' }))

  // ── Agents ─────────────────────────────────────────────────────────────
  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    const agentId = (out as { agentId?: string }).agentId
    if (isDenied(out) || agentId === undefined) return out

    const now = await $.clock.now()
    const row: AgentRow = {
      id: agentId,
      name: e.name ?? e.description,
      description: e.description,
      type: e.subagentType,
      status: 'running',
      current: 'starting…',
      toolCount: 0,
      startedAt: now,
    }
    await update($, agents, list =>
      list.some(a => a.id === agentId)
        ? list.map((a): AgentRow => (a.id === agentId ? { ...a, status: 'running', current: 'resuming…' } : a))
        : [...list, row],
    )
    return out
  })

  // Every tool call: what a subagent is doing now, and the caller's after-hook.
  on('tool.call', async ($, e, next) => {
    const current = describeCall(e.tool, e as unknown as Record<string, unknown>)
    if (e.agentId !== undefined) {
      await update($, agents, patchAgent(e.agentId, row => ({ ...row, current, toolCount: row.toolCount + 1 })))
    } else {
      await update($, main, (row): MainRow => ({ ...row, phase: 'running', current, toolCount: row.toolCount + 1 }))
    }
    const out = await next(e)
    afterToolCall?.(e.tool)
    return out
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isBusy, () => true)
      // A turn after finished work is a new request: it forecasts afresh.
      if ((await read($, main)).phase === 'done') await update($, plans, list => withPlan(list, MAIN, undefined))
      await update($, main, (row): MainRow => ({ phase: 'running', current: 'thinking…', toolCount: row.phase === 'done' ? 0 : row.toolCount }))
    } else await update($, agents, patchAgent(e.agentId, row => ({ ...row, status: 'running' })))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      await update($, isBusy, () => false)
      await update($, queued, () => 0)
      await update($, main, (row): MainRow => ({ ...row, phase: e.reason === 'answer' ? 'done' : 'idle', current: '' }))
      if (e.reason === 'answer') {
        await update($, plans, list => (list[MAIN] ? withPlan(list, MAIN, completePlan(list[MAIN])) : list))
      }
      // A main-loop turn that died with a window at 100% queues the work for the reset.
      if (e.reason === 'error') await ctl.limits?.onTurnError()
    } else {
      const status: AgentStatus = e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'completed' : 'failed'
      await update($, agents, patchAgent(e.agentId, row => ({ ...row, status, current: '' })))
      const id = e.agentId
      if (status === 'completed') {
        await update($, plans, list => (list[id] ? withPlan(list, id, completePlan(list[id])) : list))
      }
    }
    return out
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'composer' || e.command !== undefined) return next(e)
    // The person typing something takes over from a queued resume.
    if ((await read($, resume)) !== null) await ctl.limits?.cancel()

    if (e.turnId !== undefined && (await read($, isBusy))) {
      // Typed over a running turn: once the queue piles up, Claude is told to
      // pause and fold everything into the task list and agents.
      const count = await update($, queued, n => n + 1)
      if (count >= QUEUE_THRESHOLD) {
        if (count === QUEUE_THRESHOLD) $.ui.toast(`Mission Control: ${count} messages queued, reorganising into tasks`)
        return next({ ...e, context: [...(e.context ?? []), queueContext(count)] })
      }
      return next(e)
    }

    // A new piece of work clears what already finished.
    const live = await update($, agents, list => list.filter(a => !isFinished(a.status)))
    const keep = new Set([MAIN, ...live.map(a => a.id)])
    await update($, plans, list => Object.fromEntries(Object.entries(list).filter(([k]) => keep.has(k))))
    await update($, tasks, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
    return next(e)
  })
}

/** Corrects agent rows against the engine's own list (a missed end, a kill). */
export const reconcile = (list: AgentRow[], live: ReadonlyArray<{ id: string; status: string }>) => {
  const byId = new Map(live.map(a => [a.id, a.status]))
  return list.map((row): AgentRow => {
    if (row.status !== 'running') return row
    const s = byId.get(row.id)
    if (s === 'completed' || s === 'idle') return { ...row, status: 'completed', current: '' }
    if (s === 'failed') return { ...row, status: 'failed', current: '' }
    if (s === 'killed') return { ...row, status: 'killed', current: '' }
    return row
  })
}
