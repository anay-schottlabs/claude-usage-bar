import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { AgentRow, Limit, Resume, Stats, Task } from '../types'
import { ACCENT, avatarFrame, avatarGlyph, moodLabel } from './avatar'
import type { Mood } from './avatar'
import { bar, formatReset, indeterminate, limitLabel, thousands, truncate } from './format'
import { ctl } from './controllers'
import { resumeLabel } from './limits'


// Each module names the atoms it touches (the scan reads them per module).
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentRow[], { shape: 'agents-1' })
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, 0)
const isBusy = atom({ plugin: 'mission-control', key: 'isBusy' } as const, false)
const limits = atom({ plugin: 'mission-control', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const resume = atom({ plugin: 'mission-control', key: 'resume' } as const, null as Resume | null, { shape: 'resume-1' })
const stats = atom({ plugin: 'mission-control', key: 'stats' } as const, { added: 0, removed: 0, isRepo: false } as Stats, { shape: 'stats-1' })
const tasks = atom({ plugin: 'mission-control', key: 'tasks' } as const, [] as Task[], { shape: 'tasks-1' })

const MAX_TASK_ROWS = 12
const MAX_AGENT_ROWS = 8

const limitColor = (l: Limit) => {
  const p = l.percentUsed
  if (p >= 80) return 'red'
  if (l.kind === 'seven_day') return p >= 50 ? 'magenta' : 'cyan'
  return p >= 50 ? 'yellow' : 'green'
}

const agentProgress = (a: AgentRow, list: Task[], tick: number, width: number) => {
  const owned = list.filter(t => t.owner !== undefined && t.owner === a.name)
  if (owned.length > 0) {
    const done = owned.filter(t => t.status === 'completed').length
    const b = bar(a.status === 'completed' && done === 0 ? 1 : done / owned.length, width)
    return { bar: b.filled + b.empty, label: `${done}/${owned.length}` }
  }
  if (a.status === 'running') return { bar: indeterminate(tick, width), label: `${a.toolCount} tools` }
  const b = bar(1, width)
  return { bar: b.filled, label: `${a.toolCount} tools` }
}

const mood = (r: { resume: unknown; running: number; busy: boolean; total?: number }): Mood => {
  if (r.resume) return 'waiting'
  if (r.running > 0) return 'agents'
  if (r.busy) return 'working'
  if (r.total === 1) return 'done'
  return 'idle'
}

const projectLines = (s: Stats) => {
  const lines: string[] = []
  if (s.isRepo) {
    let first = s.branch ?? ''
    if (s.ahead !== undefined) first += ` ↑${s.ahead} ↓${s.behind ?? 0}`
    if (s.pushed !== undefined) first += ` · ${s.pushed} pushed, ${s.unpushed ?? 0} unpushed`
    else if (s.commits !== undefined) first += ` · ${s.commits} commits (no upstream)`
    lines.push(first)
  } else {
    lines.push('no git repo')
  }
  return lines
}

export const registerPane = (on: On) => {
  on('ui.render', { component: 'Pane', requestId: 'dashboard' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [taskList, agentList, limitList, s, tick, busy, queued] = await Promise.all([
      read($, tasks),
      read($, agents),
      read($, limits),
      read($, stats),
      read($, frame),
      read($, isBusy),
      read($, resume),
    ])
    const now = await $.clock.now()
    const W = Math.max(20, e.props.bodyColumns)

    const done = taskList.filter(t => t.status === 'completed').length
    const running = agentList.filter(a => a.status === 'running').length
    const total =
      taskList.length > 0
        ? done / taskList.length
        : agentList.length > 0
          ? (agentList.length - running) / agentList.length
          : undefined
    const m = mood({ resume: queued, running, busy, ...(total !== undefined && { total }) })
    const pct = total === undefined ? undefined : Math.round(total * 100)

    const cancelButton = queued && (
      <Box>
        <Button key="cancel-resume" label="Cancel auto-resume" onPress={() => ctl.limits?.cancel()} />
      </Box>
    )

    // ── Inline: a few rows above the prompt ──────────────────────────────
    if (e.props.placement === 'inline') {
      const parts: string[] = []
      if (pct !== undefined) {
        const b = bar(total!, 12)
        parts.push(`${b.filled}${b.empty} ${pct}%`)
      }
      if (running > 0) parts.push(`${running} agent${running === 1 ? '' : 's'}`)
      for (const l of limitList) parts.push(`${limitLabel(l.kind)} ${Math.round(l.percentUsed)}%`)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={ACCENT}>{avatarGlyph(m, tick)} </Text>
            <Text dimColor>{moodLabel(m)}</Text>
            {parts.length > 0 && <Text> · {parts.join(' · ')}</Text>}
          </Text>
          {agentList
            .filter(a => a.status === 'running')
            .slice(0, 3)
            .map(a => {
              const p = agentProgress(a, taskList, tick, 8)
              return (
                <Text wrap="truncate-end">
                  <Text color={ACCENT}>{truncate(a.name, 10).padEnd(10)}</Text> {p.bar} {p.label.padEnd(8)}
                  <Text dimColor>{a.current}</Text>
                </Text>
              )
            })}
          {queued && (
            <Text color="yellow">⏸ Limit reached · auto-resume {resumeLabel(queued.at, now)}</Text>
          )}
          {cancelButton}
        </Box>
      )
    }

    // ── Dock: the full dashboard beside the chat ─────────────────────────
    const rule = (title: string) => (
      <Text dimColor>{`─ ${title} ${'─'.repeat(Math.max(0, W - title.length - 3))}`}</Text>
    )
    const art = avatarFrame(m, tick, running)
    const totalBarWidth = Math.max(5, W - 'Total '.length - ' 100%'.length)
    const tb = bar(total ?? 0, totalBarWidth)

    const nameWidth = Math.min(10, Math.max(4, ...agentList.map(a => a.name.length)))
    const agentBarWidth = Math.max(5, Math.min(14, W - nameWidth - 12))

    const shownTasks = taskList.slice(0, MAX_TASK_ROWS)
    const hiddenTasks = taskList.length - shownTasks.length

    const limitBarWidth = Math.max(5, Math.min(30, W - 10))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="column" width={8}>
            {art.map(row => (
              <Text color={ACCENT}>{row}</Text>
            ))}
          </Box>
          <Box flexDirection="column" marginLeft={1}>
            <Text bold>{moodLabel(m)}</Text>
            <Text dimColor>
              {running > 0 ? `${running} agent${running === 1 ? '' : 's'} running` : agentList.length > 0 ? `${agentList.length} agents finished` : 'no agents'}
            </Text>
            <Text dimColor>{taskList.length > 0 ? `${done}/${taskList.length} tasks done` : 'no task list'}</Text>
          </Box>
        </Box>

        {pct !== undefined && (
          <Text>
            Total <Text color={ACCENT}>{tb.filled}</Text>
            <Text dimColor>{tb.empty}</Text> {String(pct).padStart(3)}%
          </Text>
        )}

        {queued && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">⏸ Limit reached. Auto-resume at</Text>
            <Text color="yellow">  {resumeLabel(queued.at, now)}</Text>
            {cancelButton}
          </Box>
        )}

        {agentList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {rule('agents')}
            {agentList.slice(-MAX_AGENT_ROWS).map(a => {
              const p = agentProgress(a, taskList, tick, agentBarWidth)
              const isRunning = a.status === 'running'
              const mark = a.status === 'completed' ? '✔' : a.status === 'running' ? '' : '✗'
              return (
                <Box flexDirection="column">
                  <Text wrap="truncate-end" dimColor={!isRunning}>
                    <Text color={isRunning ? ACCENT : undefined}>{truncate(a.name, nameWidth).padEnd(nameWidth)}</Text>{' '}
                    <Text color={a.status === 'failed' || a.status === 'killed' ? 'red' : isRunning ? ACCENT : 'green'}>
                      {p.bar}
                    </Text>{' '}
                    {p.label} {mark}
                  </Text>
                  {isRunning && a.current !== '' && (
                    <Text dimColor wrap="truncate-end">
                      {'  ↳ '}
                      {a.current}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {taskList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {rule('tasks')}
            {shownTasks.map(t => {
              const owner = t.owner ? ` (${t.owner})` : ''
              if (t.status === 'completed') {
                return (
                  <Text wrap="truncate-end" dimColor>
                    <Text color="green">✔</Text> {t.subject}
                    {owner}
                  </Text>
                )
              }
              if (t.status === 'in_progress') {
                return (
                  <Text wrap="truncate-end">
                    <Text color={ACCENT}>◐</Text> {t.activeForm ?? t.subject}
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
        )}

        <Box flexDirection="column" marginTop={1}>
          {rule('limits')}
          {limitList.length === 0 && <Text dimColor>no rate-limit reading yet</Text>}
          {limitList.map(l => {
            const isReset = l.resetsAt !== undefined && l.resetsAt <= now
            const p = isReset ? 0 : Math.round(Math.min(100, Math.max(0, l.percentUsed)))
            const b = bar(p / 100, limitBarWidth)
            return (
              <Box flexDirection="column">
                <Text>
                  {limitLabel(l.kind).padEnd(3)}
                  <Text color={limitColor({ ...l, percentUsed: p })}>{b.filled}</Text>
                  <Text dimColor>{b.empty}</Text> {String(p).padStart(3)}%
                </Text>
                {l.resetsAt !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    {'   '}
                    {isReset ? 'reset — waiting for a new reading' : `resets ${formatReset(l.resetsAt, now, l.kind !== 'five_hour')}`}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {rule('project')}
          {projectLines(s).map(line => (
            <Text wrap="truncate-end">{line}</Text>
          ))}
          <Text wrap="truncate-end">
            <Text color="green">+{s.added}</Text> <Text color="red">-{s.removed}</Text>
            <Text dimColor> uncommitted</Text>
            {s.codeLines !== undefined && <Text> · {thousands(s.codeLines)} lines of code</Text>}
          </Text>
        </Box>
      </Box>
    )
  })
}
