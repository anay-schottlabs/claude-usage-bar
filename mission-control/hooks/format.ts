// Pure helpers shared by the pane and the trackers: no `$` here.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Filled/empty block bar for a 0..1 fraction. */
export const bar = (fraction: number, width: number) => {
  const w = Math.max(1, width)
  const filled = Math.round(clamp(fraction, 0, 1) * w)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(w - filled) }
}

/** A sliding block for work of unknown length. */
export const indeterminate = (tick: number, width: number) => {
  const w = Math.max(3, width)
  const size = Math.max(1, Math.floor(w / 4))
  const span = w - size
  const cycle = span * 2
  const pos = cycle === 0 ? 0 : tick % cycle
  const at = pos <= span ? pos : cycle - pos
  return '░'.repeat(at) + '█'.repeat(size) + '░'.repeat(w - at - size)
}

export const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const clock12 = (d: Date) => {
  const h = d.getHours() % 12 || 12
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

export const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m`
  return `${s}s`
}

/** "3:45 PM (2h10m)", or with the date "Thu Nov 13, 3:45 PM (2d 4h)" — statusline.sh's format_reset. */
export const formatReset = (resetsAt: number, now: number, withDate: boolean) => {
  const d = new Date(resetsAt)
  const time = withDate ? `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock12(d)}` : clock12(d)
  return `${time} (${countdown(resetsAt - now)})`
}

export const truncate = (text: string, width: number) =>
  width <= 0 ? '' : text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** One-line summary of a tool call for an agent's "currently doing" line. */
export const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${base(s('file_path') || s('notebook_path'))}`
    case 'Bash':
      return `Bash ${s('command').split('\n')[0]}`
    case 'Grep':
      return `Grep "${s('pattern')}"`
    case 'Glob':
      return `Glob ${s('pattern')}`
    case 'WebFetch':
      return `Fetch ${s('url')}`
    case 'WebSearch':
      return `Search "${s('query')}"`
    case 'Agent':
      return `Agent ${s('description')}`
    case 'TaskUpdate':
      return `TaskUpdate #${s('taskId')} ${s('status')}`.trim()
    case 'TaskCreate':
      return `TaskCreate ${s('subject')}`
    case 'mcp__mission-control__progress_plan':
      return 'Planning checkpoints'
    case 'mcp__mission-control__progress_checkpoint':
      return `Checkpoint${s('label') ? `: ${s('label')}` : ' reached'}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  }
}

/** Display name of a rate-limit window kind. */
export const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind.replace(/_/g, ' ')
