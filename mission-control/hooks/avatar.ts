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

/** One row of the banner split around the bright band: dim, bright, dim. */
export type BannerRow = { before: string; lit: string; after: string; isDim: boolean }

const BAND = 4

/**
 * The banner for a mood at a frame. Working, a bright band sweeps diagonally
 * across the letters; with agents it sweeps faster; waiting, it sleeps dim;
 * done, it glows whole; idle, it rests lit with a slow shimmer.
 */
export const banner = (mood: Mood, tick: number, width: number): BannerRow[] => {
  const rows = width >= BANNER_WIDTH ? BIG_ROWS : SMALL_ROWS
  const w = rows[0]!.length
  const cycle = w + rows.length + BAND * 2 + 8
  const speed = mood === 'agents' ? 3 : 2
  const head = ((tick * speed) % cycle) - BAND

  return rows.map((row, r) => {
    if (mood === 'waiting') return { before: row, lit: '', after: '', isDim: true }
    if (mood === 'done') return tick % 8 < 4 ? { before: '', lit: row, after: '', isDim: false } : { before: row, lit: '', after: '', isDim: false }
    if (mood === 'idle' && (tick * 2) % (w + 20) >= w) return { before: row, lit: '', after: '', isDim: false }
    // A diagonal: lower rows lag a column per row.
    const start = Math.max(0, Math.min(w, (mood === 'idle' ? (tick * 2) % (w + 20) : head) - r))
    const end = Math.max(0, Math.min(w, start + BAND))
    return { before: row.slice(0, start), lit: row.slice(start, end), after: row.slice(end), isDim: mood !== 'idle' }
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
