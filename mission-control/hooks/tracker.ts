// Tracker: mirrors what the model does into the dashboard's state. It follows
// the task tools (TaskCreate/TaskUpdate/TodoWrite), subagents and their turns,
// the main loop's turns and current tool, and prompts queued mid-turn, and it
// answers the mod's own progress-forecast tools.

import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { AgentRow, AgentStatus, MainRow, Plan, Resume, Task, TaskStatus } from '../types'
import { describeActivity } from './activity'
import { ctl } from './controllers'
import { queueContext, QUEUE_THRESHOLD } from './instructions'
import { applyCheckpoint, applyPlan, CHECKPOINT_TOOL_FULL, completePlan, planLabel, PLAN_TOOL_FULL } from './progress'
import type { PlanInput } from './progress'

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

/** The main loop's key in `plans`; subagents' plans are keyed by agent id. */
const MAIN = 'main'

/** A copy of `all` with `key`'s plan set, or removed when `plan` is undefined. */
const withPlan = (all: Record<string, Plan>, key: string, plan: Plan | undefined) => {
  const copy = { ...all }
  if (plan) copy[key] = plan
  else delete copy[key]
  return copy
}

/** A plans mapper that marks `key`'s plan done, if it has one. */
const finishPlan = (key: string) => (all: Record<string, Plan>) => {
  const plan = all[key]
  return plan ? withPlan(all, key, completePlan(plan)) : all
}

/** A hook (ours or another's) refused the call: nothing happened to mirror. */
const isDenied = (out: unknown) =>
  typeof out === 'object' && out !== null && 'deny' in out && (out as { deny?: unknown }).deny !== undefined

/** A list mapper that patches one agent's row. */
const patchAgent = (id: string, fn: (row: AgentRow) => AgentRow) => (list: AgentRow[]) =>
  list.map(row => (row.id === id ? fn(row) : row))

/** How a subagent's run ended, from its turn's end reason. */
const agentEnd = (reason: string): AgentStatus =>
  reason === 'aborted' ? 'killed' : reason === 'answer' ? 'completed' : 'failed'

/**
 * Registers every tracking hook. `afterToolCall` runs once each tool call has
 * finished, so the caller can react (e.g. refresh git figures after an edit).
 */
export const registerTracker = (on: On, afterToolCall?: (tool: string) => void) => {
  // ── Task list ──────────────────────────────────────────────────────────
  // These run after `next` so only calls the engine carried out are mirrored.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const out = await next(e)
    if (isDenied(out) || out.isError) return out
    // The tool mints the id, so it is only known from the result.
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

    // A subagent that starts an unowned task claims it, so its bar counts it.
    let claimant: string | undefined
    if (e.owner === undefined && e.agentId !== undefined && e.status === 'in_progress') {
      claimant = (await read($, agents)).find(a => a.id === e.agentId)?.name
    }

    await update($, tasks, list => {
      if (e.status === 'deleted') return list.filter(t => t.id !== e.taskId)
      const known = list.find(t => t.id === e.taskId)
      // A task created before this load (or by a TaskCreate we missed) is adopted.
      const base: Task = known ?? { id: e.taskId, subject: e.subject ?? `Task ${e.taskId}`, status: 'pending' }
      // An explicit owner always wins; a claim never displaces an existing owner.
      const owner = e.owner ?? base.owner ?? claimant
      const merged: Task = {
        ...base,
        ...(e.subject !== undefined && { subject: e.subject }),
        ...(e.activeForm !== undefined && { activeForm: e.activeForm }),
        ...(e.status !== undefined && { status: e.status as TaskStatus }),
        ...(owner !== undefined && { owner }),
      }
      return known ? list.map(t => (t === known ? merged : t)) : [...list, merged]
    })
    return out
  })

  // Sessions that use the older todo list instead of tasks: it is rewritten whole.
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
  // Each loop (main, or a subagent by id) keeps its own plan.
  on('tool.call', { tool: 'mcp__mission-control__progress_plan' }, async ($, e) => {
    const key = e.agentId ?? MAIN
    const now = await $.clock.now()
    const input = e as unknown as PlanInput
    const all = await update($, plans, list => withPlan(list, key, applyPlan(list[key], input, now)))
    const plan = all[key]!
    const secs = plan.checkpoints.reduce((n, c) => n + c.seconds, 0)
    return {
      result: `Plan recorded: ${plan.checkpoints.length} checkpoints, about ${Math.round(secs / 60)} min. Call ${CHECKPOINT_TOOL_FULL} as each one is reached.`,
    }
  })

  on('tool.call', { tool: 'mcp__mission-control__progress_checkpoint' }, async ($, e) => {
    const key = e.agentId ?? MAIN
    const now = await $.clock.now()
    const all = await update($, plans, list => {
      const plan = list[key]
      return plan ? withPlan(list, key, applyCheckpoint(plan, now)) : list
    })
    const plan = all[key]
    if (!plan) return { result: `No plan yet: call ${PLAN_TOOL_FULL} first.` }
    return { result: plan.isComplete ? 'All checkpoints reached.' : `Checkpoint reached (${planLabel(plan)} next).` }
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
    // A spawn that answers a known id resumes that agent: keep its row and counts.
    await update($, agents, list =>
      list.some(a => a.id === agentId)
        ? list.map((a): AgentRow => (a.id === agentId ? { ...a, status: 'running', current: 'resuming…' } : a))
        : [...list, row],
    )
    return out
  })

  // Every tool call: what its loop is doing now, then the caller's after-hook.
  on('tool.call', async ($, e, next) => {
    const current = describeActivity(e.tool, e as unknown as Record<string, unknown>)
    if (e.agentId !== undefined) {
      await update($, agents, patchAgent(e.agentId, row => ({ ...row, current, toolCount: row.toolCount + 1 })))
    } else {
      await update($, main, (row): MainRow => ({ ...row, phase: 'running', current, toolCount: row.toolCount + 1 }))
    }
    const out = await next(e)
    afterToolCall?.(e.tool)
    return out
  })

  // ── Turns ──────────────────────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A finished agent woken again (e.g. by a message) is running once more;
      // its last line was cleared at its end, so give it one.
      await update(
        $,
        agents,
        patchAgent(e.agentId, (row): AgentRow => (row.status === 'running' ? row : { ...row, status: 'running', current: 'thinking…' })),
      )
      return next(e)
    }

    await update($, isBusy, () => true)
    // The plan and tool count carry on: a turn started by an agent's report,
    // a notification or a resume continues the same work. Only a prompt the
    // person types starts a new piece of work (see prompt.submit below).
    await update($, main, (row): MainRow => ({ ...row, phase: 'running', current: 'thinking…' }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      const status = agentEnd(e.reason)
      await update($, agents, patchAgent(id, row => ({ ...row, status, current: '' })))
      if (status === 'completed') await update($, plans, finishPlan(id))
      return out
    }

    // Prompts queued during the turn are handed over as it ends.
    await update($, isBusy, () => false)
    await update($, queued, () => 0)
    const isAnswered = e.reason === 'answer'
    await update($, main, (row): MainRow => ({ ...row, phase: isAnswered ? 'done' : 'idle', current: '' }))
    // Answering while agents still run is a hand-off, not the end of the work:
    // the plan completes once nothing is left running.
    const isAgentRunning = (await read($, agents)).some(a => a.status === 'running')
    if (isAnswered && !isAgentRunning) await update($, plans, finishPlan(MAIN))
    // A main-loop turn that died with a window at 100% queues the work for the reset.
    if (e.reason === 'error') await ctl.limits?.onTurnError()
    return out
  })

  // ── Prompts the person types ───────────────────────────────────────────
  on('prompt.submit', async ($, e, next) => {
    // Only the person's own typing counts: not slash commands, nor prompts from
    // plugins (the auto-resume among them), notifications or peers.
    if (e.origin?.kind !== 'composer' || e.command !== undefined) return next(e)
    // The person typing something takes over from a queued resume.
    if ((await read($, resume)) !== null) await ctl.limits?.cancel()

    if (e.turnId !== undefined && (await read($, isBusy))) {
      // Typed over a running turn: once the queue piles up, Claude is told to
      // pause and fold everything into the task list and agents.
      const count = await update($, queued, n => n + 1)
      if (count < QUEUE_THRESHOLD) return next(e)
      if (count === QUEUE_THRESHOLD) void $.ui.toast(`Mission Control: ${count} messages queued, reorganising into tasks`)
      return next({ ...e, context: [...(e.context ?? []), queueContext(count)] })
    }

    // A new piece of work clears what already finished: ended agents, their
    // plans, the main thread's plan and tool count (it forecasts afresh), and a
    // task list with nothing left to do.
    const live = await update($, agents, list => list.filter(a => a.status === 'running'))
    const keep = new Set(live.map(a => a.id))
    await update($, main, (row): MainRow => ({ ...row, toolCount: 0 }))
    await update($, plans, list => Object.fromEntries(Object.entries(list).filter(([k]) => keep.has(k))))
    await update($, tasks, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
    return next(e)
  })
}

/**
 * Corrects running agent rows against the engine's own list, for ends the
 * hooks never heard (a kill from elsewhere, a spawn nested in another hook).
 * An agent the engine does not list is left as it is.
 */
export const reconcile = (list: AgentRow[], live: ReadonlyArray<{ id: string; status: string }>) => {
  const byId = new Map(live.map(a => [a.id, a.status]))
  return list.map((row): AgentRow => {
    if (row.status !== 'running') return row
    const s = byId.get(row.id)
    if (s === 'completed' || s === 'idle') return { ...row, status: 'completed', current: '' }
    if (s === 'failed' || s === 'killed') return { ...row, status: s, current: '' }
    return row
  })
}
