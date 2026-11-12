import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { AgentRow, Limit, MainRow, Resume, Stats, Task } from '../types'
import { ACCENT, banner, glyph, moodLabel } from './avatar'
import type { Mood } from './avatar'
import { ctl } from './controllers'
import { bar, formatReset, indeterminate, limitLabel, thousands, truncate } from './format'
import { resumeLabel } from './limits'

// Each module names the atoms it touches (the scan reads them per module).
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, 0)
const isBusy = atom({ plugin: 'mission-control', key: 'isBusy' } as const, false)
const limits = atom({ plugin: 'mission-control', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const resume = atom({ plugin: 'mission-control', key: 'resume' } as const, null as Resume | null, { shape: 'resume-1' })
const stats = atom({ plugin: 'mission-control', key: 'stats' } as const, { added: 0, removed: 0, isRepo: false } as Stats, { shape: 'stats-1' })
const tasks = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as Task[], { shape: 'tasks-1' })
const main = atom({ plugin: 'mission-control', key: 'main' } as const, { phase: 'idle', current: '', toolCount: 0 } as MainRow, {
  shape: 'main-1',
})
const queued = atom({ plugin: 'mission-control', key: 'queued' } as const, 0)

const MAX_TASK_ROWS = 14
const MAX_AGENT_ROWS = 8
const MAIN = 'main'

const limitColor = (l: Limit) => {
  const p = l.percentUsed
  if (p >= 80) return 'error'
  if (l.kind === 'seven_day') return p >= 50 ? 'merged' : 'suggestion'
  return p >= 50 ? 'warning' : 'success'
}

type Row = {
  key: string
  name: string
  isRunning: boolean
  status: 'running' | 'completed' | 'failed' | 'killed' | 'idle'
  current: string
  toolCount: number
}

/** A row's bar: its owned tasks when it has any, else a sweep while it works. */
const progress = (row: Row, owned: Task[], tick: number, width: number) => {
  if (owned.length > 0) {
    const done = owned.filter(t => t.status === 'completed').length
    const b = bar(done / owned.length, width)
    return { filled: b.filled, empty: b.empty, label: `${done}/${owned.length}` }
  }
  if (row.isRunning) return { filled: indeterminate(tick, width), empty: '', label: `${row.toolCount} tools` }
  if (row.status === 'idle') return { filled: '', empty: bar(0, width).empty, label: '' }
  return { filled: bar(1, width).filled, empty: '', label: `${row.toolCount} tools` }
}

const pickMood = (r: { resume: unknown; running: number; busy: boolean; isDone: boolean }): Mood => {
  if (r.resume) return 'waiting'
  if (r.running > 0) return 'agents'
  if (r.busy) return 'working'
  if (r.isDone) return 'done'
  return 'idle'
}

export const registerPane = (on: On) => {
  on('ui.render', { component: 'Pane', requestId: 'dashboard' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [taskList, agentList, limitList, s, tick, busy, queuedResume, mainRow, queuedCount] = await Promise.all([
      read($, tasks),
      read($, agents),
      read($, limits),
      read($, stats),
      read($, frame),
      read($, isBusy),
      read($, resume),
      read($, main),
      read($, queued),
    ])
    const now = await $.clock.now()
    const isInline = e.props.placement === 'inline'
    // Dock: one column of padding each side.
    const W = Math.max(20, e.props.bodyColumns - (isInline ? 0 : 2))

    // ── Rows: the main thread first, then each subagent ──────────────────
    const agentNames = new Set(agentList.map(a => a.name))
    const rows: Row[] = [
      {
        key: MAIN,
        name: MAIN,
        isRunning: mainRow.phase === 'running',
        status: mainRow.phase === 'running' ? 'running' : mainRow.phase === 'done' ? 'completed' : 'idle',
        current: mainRow.phase === 'running' ? mainRow.current : mainRow.phase === 'done' ? 'waiting for you' : 'ready',
        toolCount: mainRow.toolCount,
      },
      ...agentList.slice(-MAX_AGENT_ROWS).map(
        (a): Row => ({
          key: a.id,
          name: a.name,
          isRunning: a.status === 'running',
          status: a.status,
          current: a.current,
          toolCount: a.toolCount,
        }),
      ),
    ]
    // Tasks no agent owns are the main thread's.
    const ownedBy = (row: Row) =>
      row.key === MAIN
        ? taskList.filter(t => t.owner === undefined || t.owner === MAIN || !agentNames.has(t.owner))
        : taskList.filter(t => t.owner === row.name)

    // ── Total: always drawn ──────────────────────────────────────────────
    const done = taskList.filter(t => t.status === 'completed').length
    const running = agentList.filter(a => a.status === 'running').length
    let total: { fraction?: number; label: string }
    if (taskList.length > 0) total = { fraction: done / taskList.length, label: `${done}/${taskList.length} tasks` }
    else if (agentList.length > 0 && (running > 0 || busy))
      total = { fraction: (agentList.length - running) / agentList.length, label: `${agentList.length - running}/${agentList.length} agents` }
    else if (busy) total = { label: 'working' }
    else if (mainRow.phase === 'done') total = { fraction: 1, label: 'done' }
    else total = { fraction: 0, label: 'ready' }
    const pct = total.fraction === undefined ? undefined : Math.round(total.fraction * 100)

    const isDone = !busy && running === 0 && (taskList.length > 0 ? done === taskList.length : mainRow.phase === 'done')
    const m = pickMood({ resume: queuedResume, running, busy, isDone })

    const statusLine = [
      moodLabel(m),
      running > 0 ? `${running} agent${running === 1 ? '' : 's'}` : '',
      queuedCount > 0 ? `${queuedCount} queued` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const totalBar = (width: number) => {
      const b = total.fraction === undefined ? { filled: indeterminate(tick, width), empty: '' } : bar(total.fraction, width)
      return (
        <Text>
          <Text color={ACCENT}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text bold> {pct === undefined ? '' : `${pct}% `}</Text>
          <Text dimColor>{total.label}</Text>
        </Text>
      )
    }

    const cancelButton = queuedResume && (
      <Box>
        <Button key="cancel-resume" label="Cancel auto-resume" onPress={() => ctl.limits?.cancel()} />
      </Box>
    )

    // ── Inline: a few rows above the prompt ──────────────────────────────
    if (isInline) {
      const limitsText = limitList.map(l => `${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%`).join(' · ')
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={ACCENT} bold>
              {glyph(m, tick)} Claude{' '}
            </Text>
            <Text dimColor>{statusLine}</Text>
            {limitsText !== '' && <Text dimColor> · {limitsText}</Text>}
          </Text>
          {totalBar(Math.max(8, Math.min(30, W - 20)))}
          {rows
            .filter(r => r.isRunning)
            .slice(0, 4)
            .map(r => {
              const p = progress(r, ownedBy(r), tick, 8)
              return (
                <Text wrap="truncate-end">
                  <Text color={ACCENT}>{truncate(r.name, 8).padEnd(8)}</Text> {p.filled}
                  <Text dimColor>{p.empty}</Text> <Text dimColor>{r.current}</Text>
                </Text>
              )
            })}
          {queuedResume && <Text color="warning">⏸ Limit reached · auto-resume {resumeLabel(queuedResume.at, now)}</Text>}
          {cancelButton}
        </Box>
      )
    }

    // ── Dock: the full dashboard beside the chat ─────────────────────────
    const section = (title: string) => (
      <Text dimColor>{`── ${title} ${'─'.repeat(Math.max(0, W - title.length - 4))}`}</Text>
    )
    const nameWidth = Math.min(10, Math.max(4, ...rows.map(r => r.name.length)))
    const rowBarWidth = Math.max(6, Math.min(24, W - nameWidth - 10))
    const shownTasks = taskList.slice(0, MAX_TASK_ROWS)
    const hiddenTasks = taskList.length - shownTasks.length
    const limitBarWidth = Math.max(6, Math.min(36, W - 9))

    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        {/* Header: the banner, then what is going on */}
        <Box flexDirection="column">
          {banner(m, tick, W).map(r => (
            <Text>
              <Text color={ACCENT} dimColor={r.isDim}>
                {r.before}
              </Text>
              <Text color="text" bold>
                {r.lit}
              </Text>
              <Text color={ACCENT} dimColor={r.isDim}>
                {r.after}
              </Text>
            </Text>
          ))}
          <Box marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={ACCENT} bold>
                {glyph(m, tick)}{' '}
              </Text>
              <Text bold>{statusLine}</Text>
            </Text>
          </Box>
        </Box>

        {/* Total progress */}
        <Box flexDirection="column" marginTop={1}>
          {section('progress')}
          <Box marginTop={1}>{totalBar(Math.max(8, W - 18))}</Box>
        </Box>

        {queuedResume && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="warning">⏸ Limit reached. Auto-resume at</Text>
            <Text color="warning">  {resumeLabel(queuedResume.at, now)}</Text>
            {cancelButton}
          </Box>
        )}

        {/* Agents, the main thread first */}
        <Box flexDirection="column" marginTop={1}>
          {section('agents')}
          {rows.map(r => {
            const p = progress(r, ownedBy(r), tick, rowBarWidth)
            const isBad = r.status === 'failed' || r.status === 'killed'
            const mark = r.status === 'completed' && r.key !== MAIN ? ' ✔' : isBad ? ' ✗' : ''
            const barColor = isBad ? 'error' : r.isRunning ? ACCENT : 'success'
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text wrap="truncate-end">
                  <Text color={r.isRunning ? ACCENT : undefined} bold={r.isRunning} dimColor={!r.isRunning}>
                    {truncate(r.name, nameWidth).padEnd(nameWidth)}
                  </Text>{' '}
                  <Text color={barColor}>{p.filled}</Text>
                  <Text dimColor>{p.empty}</Text>
                  <Text dimColor>
                    {' '}
                    {p.label}
                    {mark}
                  </Text>
                </Text>
                {r.current !== '' && (
                  <Text dimColor={!r.isRunning} wrap="truncate-end">
                    <Text dimColor>{'  ↳ '}</Text>
                    {r.current}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        {taskList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {section('tasks')}
            <Box flexDirection="column" marginTop={1}>
              {shownTasks.map(t => {
                const owner = t.owner && t.owner !== MAIN ? ` (${t.owner})` : ''
                if (t.status === 'completed') {
                  return (
                    <Text wrap="truncate-end" dimColor>
                      <Text color="success">✔</Text> {t.subject}
                      {owner}
                    </Text>
                  )
                }
                if (t.status === 'in_progress') {
                  return (
                    <Text wrap="truncate-end">
                      <Text color={ACCENT}>◐</Text> <Text bold>{t.activeForm ?? t.subject}</Text>
                      <Text dimColor>{owner}</Text>
                    </Text>
                  )
                }
                return (
                  <Text wrap="truncate-end">
                    <Text dimColor>○</Text> {t.subject}
                    <Text dimColor>{owner}</Text>
                  </Text>
                )
              })}
              {hiddenTasks > 0 && <Text dimColor>  +{hiddenTasks} more</Text>}
            </Box>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {section('limits')}
          {limitList.length === 0 && (
            <Box marginTop={1}>
              <Text dimColor>no rate-limit reading yet</Text>
            </Box>
          )}
          {limitList.map(l => {
            const isReset = l.resetsAt !== undefined && l.resetsAt <= now
            const p = isReset ? 0 : Math.round(Math.min(100, Math.max(0, l.percentUsed)))
            const b = bar(p / 100, limitBarWidth)
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text bold>{limitLabel(l.kind).padEnd(3)}</Text>
                  <Text color={limitColor({ ...l, percentUsed: p })}>{b.filled}</Text>
                  <Text dimColor>{b.empty}</Text> {String(p).padStart(3)}%
                </Text>
                {l.resetsAt !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    {'   '}
                    {isReset ? 'reset, waiting for a new reading' : `resets ${formatReset(l.resetsAt, now, l.kind !== 'five_hour')}`}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {section('project')}
          <Box flexDirection="column" marginTop={1}>
            {s.isRepo ? (
              <Text wrap="truncate-end">
                <Text bold>{s.branch}</Text>
                {s.ahead !== undefined && <Text dimColor>{` ↑${s.ahead} ↓${s.behind ?? 0}`}</Text>}
              </Text>
            ) : (
              <Text dimColor>no git repo</Text>
            )}
            {s.pushed !== undefined && (
              <Text dimColor wrap="truncate-end">
                {s.pushed} pushed · {s.unpushed ?? 0} unpushed
              </Text>
            )}
            {s.commits !== undefined && <Text dimColor>{s.commits} commits (no upstream)</Text>}
            <Text wrap="truncate-end">
              <Text color="success">+{s.added}</Text> <Text color="error">-{s.removed}</Text>
              <Text dimColor> uncommitted</Text>
            </Text>
            {s.codeLines !== undefined && <Text dimColor>{thousands(s.codeLines)} lines of code</Text>}
          </Box>
        </Box>
      </Box>
    )
  })
}
