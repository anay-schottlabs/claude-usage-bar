// The dashboard's header: "CLAUDE" in block letters with a band of light
// sweeping across it, plus the spinner glyph and mood label beside the status
// line. Pure functions of (mood, frame tick, width): the pane re-renders on
// every `frame` tick and these decide what each frame looks like.

/**
 * What the header is showing. `agents` is `working` with subagents running
 * (a faster shine); `waiting` means a rate limit stopped work and an
 * auto-resume is queued; `done` means the last piece of work finished.
 */
export type Mood = 'idle' | 'working' | 'agents' | 'waiting' | 'done'

/** Claude Code theme key for Claude's own color, so the dashboard follows the person's theme. */
export const ACCENT = 'claude'

// Five rows, each letter seven columns, one column between letters.
const BIG: Record<string, string[]> = {
  C: [' ██████', '██     ', '██     ', '██     ', ' ██████'],
  L: ['██     ', '██     ', '██     ', '██     ', '███████'],
  A: [' █████ ', '██   ██', '███████', '██   ██', '██   ██'],
  U: ['██   ██', '██   ██', '██   ██', '██   ██', ' █████ '],
  D: ['██████ ', '██   ██', '██   ██', '██   ██', '██████ '],
  E: ['███████', '██     ', '█████  ', '██     ', '███████'],
}

// Three rows of box-drawing for a narrow pane.
const SMALL: Record<string, string[]> = {
  C: ['╭─╴', '│  ', '╰─╴'],
  L: ['╷  ', '│  ', '╰─╴'],
  A: ['╭─╮', '├─┤', '╵ ╵'],
  U: ['╷ ╷', '│ │', '╰─╯'],
  D: ['┌─╮', '│ │', '└─╯'],
  E: ['╭─╴', '├╴ ', '╰─╴'],
}

/** Lays out `word` in `font`: one string per row, letters joined by a single space. */
const spell = (font: Record<string, string[]>, word: string) => {
  const letters = [...word].map(ch => font[ch]!)
  return letters[0]!.map((_, row) => letters.map(l => l[row]).join(' '))
}

const BIG_ROWS = spell(BIG, 'CLAUDE')
const SMALL_ROWS = spell(SMALL, 'CLAUDE')
/** Columns the block-letter banner needs; narrower panes get the small box-drawing one. */
export const BANNER_WIDTH = BIG_ROWS[0]!.length

/**
 * One row of the banner split around the bright band: `before` and `after`
 * draw in `color` (dimmed when `isDim`), `lit` in bold `litColor`.
 */
export type BannerRow = { before: string; lit: string; after: string; isDim: boolean; color: string; litColor: string }

/** Gray at rest; Claude's color while anything works. */
const IDLE_COLOR = 'inactive'
/** The shine: white over gray; Claude's lighter shimmer shade over its color. */
const IDLE_SHINE = 'text'
const WORKING_SHINE = 'claudeShimmer'

/** Width of the bright band, in columns. */
const BAND = 4

/**
 * The banner for a mood at a frame: a bright band shines across the letters
 * from left to right, then rests before the next pass. Idle (and done), the
 * letters are gray with a slow shine; working, they are Claude's color with
 * a quicker one; waiting for a limit reset, they sleep gray and dim.
 */
export const banner = (mood: Mood, tick: number, width: number): BannerRow[] => {
  const rows = width >= BANNER_WIDTH ? BIG_ROWS : SMALL_ROWS
  const w = rows[0]!.length
  const isWorking = mood === 'working' || mood === 'agents'
  const color = isWorking ? ACCENT : IDLE_COLOR
  // Columns per tick, and a rest after each pass so it reads as a shine.
  // The cycle covers the word, the diagonal's lag (one column per row), the
  // band itself, then the rest: offscreen ticks where nothing is lit.
  const speed = mood === 'agents' ? 5 : isWorking ? 4 : 3
  const cycle = w + rows.length + BAND + (isWorking ? 12 : 8)
  const head = (tick * speed) % cycle

  return rows.map((row, r) => {
    const plain = { before: row, lit: '', after: '', isDim: false, color, litColor: isWorking ? WORKING_SHINE : IDLE_SHINE }
    if (mood === 'waiting') return { ...plain, isDim: true }
    // A slight diagonal: lower rows trail by a column each.
    const start = head - r
    if (start >= w || start + BAND <= 0) return plain
    const a = Math.max(0, start)
    const b = Math.min(w, start + BAND)
    return { ...plain, before: row.slice(0, a), lit: row.slice(a, b), after: row.slice(b) }
  })
}

/** The spinner glyph beside the status line: a snoring z while waiting, a still star at rest, a turning one at work. */
export const glyph = (mood: Mood, tick: number) => {
  if (mood === 'waiting') return ['z', 'Z', 'z', ' '][tick % 4]!
  if (mood === 'done') return '✸'
  if (mood === 'idle') return '✻'
  return ['✻', '✼', '✽', '✾', '✽', '✼'][tick % 6]!
}

/** The status line's leading words for a mood. */
export const moodLabel = (mood: Mood) =>
  ({ idle: 'idle', working: 'working…', agents: 'agents at work', waiting: 'waiting for limit reset', done: 'all done' })[mood]
