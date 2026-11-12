import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { AgentRow, AgentStatus, Resume, Task, TaskStatus } from '../types'
import { describeCall } from './format'
import { ctl } from './controllers'

// Each module names the atoms it touches (the scan reads them per module).
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const isBusy = atom({ plugin: 'mission-control', key: 'isBusy' } as const, false)
const resume = atom({ plugin: 'mission-control', key: 'resume' } as const, null as Resume | null, { shape: 'resume-1' })
const tasks = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as Task[], { shape: 'tasks-1' })

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
    if (e.agentId !== undefined) {
      const current = describeCall(e.tool, e as unknown as Record<string, unknown>)
      await update($, agents, patchAgent(e.agentId, row => ({ ...row, current, toolCount: row.toolCount + 1 })))
    }
    const out = await next(e)
    afterToolCall?.(e.tool)
    return out
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, isBusy, () => true)
    else await update($, agents, patchAgent(e.agentId, row => ({ ...row, status: 'running' })))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      await update($, isBusy, () => false)
      // A main-loop turn that died with a window at 100% queues the work for the reset.
      if (e.reason === 'error') await ctl.limits?.onTurnError()
    } else {
      const status: AgentStatus = e.reason === 'aborted' ? 'killed' : e.reason === 'answer' ? 'completed' : 'failed'
      await update($, agents, patchAgent(e.agentId, row => ({ ...row, status, current: '' })))
    }
    return out
  })

  // A new piece of work typed by the person clears what already finished.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' && e.command === undefined) {
      // The person typing something takes over from a queued resume.
      if ((await read($, resume)) !== null) await ctl.limits?.cancel()
      await update($, agents, list => list.filter(a => !isFinished(a.status)))
      await update($, tasks, list => (list.length > 0 && list.every(t => t.status === 'completed') ? [] : list))
    }
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
