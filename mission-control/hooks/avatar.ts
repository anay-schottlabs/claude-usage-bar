// The header: "CLAUDE" in block letters with a light sweeping across it.

export type Mood = 'idle' | 'working' | 'agents' | 'waiting' | 'done'

// Theme keys, so the dashboard follows the person's Claude Code theme.
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

const spell = (font: Record<string, string[]>, word: string) => {
  const letters = [...word].map(ch => font[ch]!)
  return letters[0]!.map((_, row) => letters.map(l => l[row]).join(' '))
}

const BIG_ROWS = spell(BIG, 'CLAUDE')
const SMALL_ROWS = spell(SMALL, 'CLAUDE')
export const BANNER_WIDTH = BIG_ROWS[0]!.length

/** One row of the banner split around the bright band, and its base color. */
export type BannerRow = { before: string; lit: string; after: string; isDim: boolean; color: string; litColor: string }

/** Gray at rest; Claude's color while anything works. */
const IDLE_COLOR = 'inactive'
/** The shine: white over gray; Claude's lighter shimmer shade over its color. */
const IDLE_SHINE = 'text'
const WORKING_SHINE = 'claudeShimmer'

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

/** The spinner glyph beside the status line. */
export const glyph = (mood: Mood, tick: number) => {
  if (mood === 'waiting') return ['z', 'Z', 'z', ' '][tick % 4]!
  if (mood === 'done') return '✸'
  if (mood === 'idle') return '✻'
  return ['✻', '✼', '✽', '✾', '✽', '✼'][tick % 6]!
}

export const moodLabel = (mood: Mood) =>
  ({ idle: 'idle', working: 'working…', agents: 'agents at work', waiting: 'waiting for limit reset', done: 'all done' })[mood]
