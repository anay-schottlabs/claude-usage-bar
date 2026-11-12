import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, Limit, Resume, Stats } from '../types'

import { ctl } from './controllers'
import { WORKFLOW_SECTION } from './instructions'
import { makeLimits, toLimit } from './limits'
import { registerPane } from './pane'
import { PANE, TITLE } from './state'
import { CHECKPOINT_SPEC, PLAN_SPEC } from './progress'
import { collectStats } from './stats'
import { reconcile, registerTracker } from './tracker'

// Each module names the atoms it touches (the scan reads them per module).
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, 0)
const isBusy = atom({ plugin: 'mission-control', key: 'isBusy' } as const, false)
const limits = atom({ plugin: 'mission-control', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const resume = atom({ plugin: 'mission-control', key: 'resume' } as const, null as Resume | null, { shape: 'resume-1' })
const stats = atom({ plugin: 'mission-control', key: 'stats' } as const, { added: 0, removed: 0, isRepo: false } as Stats, { shape: 'stats-1' })

const TICK_MS = 150
const LIMIT_SYNC_TICKS = Math.round(5000 / TICK_MS)
const STATS_TICKS = Math.round(30000 / TICK_MS)
const AGENT_SYNC_TICKS = Math.round(3000 / TICK_MS)

const STATS_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])

export const register: Register = on => {
  // Edits and commands change the git figures: refresh them shortly after.
  registerTracker(on, tool => {
    if (STATS_TOOLS.has(tool)) ctl.touchStats?.()
  })
  registerPane(on)

  // Every chat is told how to keep the dashboard's data structured.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    return { sections: [...out.sections.filter(s => s.id !== WORKFLOW_SECTION.id), WORKFLOW_SECTION] }
  })

  on('session.start', async ($, e, next) => {
    const cwd = e.cwd

    ctl.limits = makeLimits({
      now: () => $.clock.now(),
      sessionId: async () => String(await $.session.id()),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      storeDelete: key => $.store.delete(key),
      getShown: () => read($, limits),
      setShown: list => update($, limits, () => list),
      setResume: r => update($, resume, () => r),
      usage: async () => (await $.session.usage()).rateLimits,
      after: (ms, fn) => $.clock.after(ms, fn),
      submit: text => void $.prompt.submit({ text }),
      toast: text => $.ui.toast(text),
    })

    const refreshStats = async () => {
      const fresh = await collectStats((argv, init) => $.process.run(argv, init), cwd, await $.clock.now())
      await update($, stats, () => fresh)
    }
    let statsPending: { cancel: () => void } | undefined
    ctl.touchStats = () => {
      if (statsPending) return
      statsPending = $.clock.after(1500, () => {
        statsPending = undefined
        void refreshStats().catch(() => undefined)
      })
    }

    // The tools Claude forecasts and reports progress with.
    await $.tool.register(PLAN_SPEC)
    await $.tool.register(CHECKPOINT_SPEC)

    await $.command.register({
      name: 'mission',
      description: 'Open the Mission Control dashboard beside the chat',
      argumentHint: '[test-resume <seconds> | cancel-resume]',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    const usage = await $.session.usage()
    await ctl.limits.apply(usage.rateLimits.map(toLimit))
    await ctl.limits.restore()
    void refreshStats().catch(() => undefined)

    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks++
      void (async () => {
        const rows = await read($, agents)
        const isActive =
          (await read($, isBusy)) || (await read($, resume)) !== null || rows.some(a => a.status === 'running')
        // Animate briskly while something is happening, slowly when idle.
        if (isActive || ticks % 2 === 0) await update($, frame, n => (n + 1) % 1_000_000)
        if (ticks % LIMIT_SYNC_TICKS === 0) await ctl.limits?.apply()
        if (ticks % AGENT_SYNC_TICKS === 0 && rows.some(a => a.status === 'running')) {
          const live = await $.agent.list()
          await update($, agents, list => reconcile(list, live))
        }
        if (ticks % STATS_TICKS === 0) await refreshStats()
      })().catch(() => undefined)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await ctl.limits?.apply(e.rateLimits.map(toLimit))
    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'test-resume' && ctl.limits) {
      const secs = Math.max(5, parseInt(arg ?? '60', 10) || 60)
      await ctl.limits.arm((await $.clock.now()) + secs * 1000, 'five_hour')
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: `Mission Control: simulated limit; auto-resume fires in ${secs}s (it checks the real limits first).` }
    }
    if (sub === 'cancel-resume' && ctl.limits) {
      await ctl.limits.cancel()
      return { text: 'Mission Control: auto-resume cancelled.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced ? 'Mission Control opened.' : `Mission Control is open but not drawn: ${opened.reason}`,
    }
  })
}
