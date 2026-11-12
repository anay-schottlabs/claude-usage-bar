// The ASCII Claude spark: three rows, seven columns, one frame per tick.

export type Mood = 'idle' | 'working' | 'agents' | 'waiting' | 'done'

export const ACCENT = '#D97757'

const PLUS = ['   |   ', ' --✻-- ', '   |   ']
const CROSS = [' \\   / ', '   ✻   ', ' /   \\ ']
const STAR = [' \\ | / ', ' --✻-- ', ' / | \\ ']
const BURST = [' \\ | / ', '-- ✸ --', ' / | \\ ']

const WORKING = [PLUS, STAR, CROSS, STAR]

// Dots orbiting the spark, one step per frame.
const ORBIT: Array<[number, number]> = [
  [0, 3], [0, 5], [1, 6], [2, 5], [2, 3], [2, 1], [1, 0], [0, 1],
]

const IDLE = [
  ['       ', '   ✻   ', '       '],
  ['       ', '   ✻   ', '       '],
  ['   ·   ', '  ·✻·  ', '   ·   '],
  ['       ', '   ✻   ', '       '],
]

const WAITING = [
  ['     z ', '   ✻   ', '       '],
  ['    Z  ', '   ✻ z ', '       '],
  ['   z   ', '   ✻Z  ', '       '],
  ['       ', '   ✻ z ', '       '],
]

const place = (rows: string[], dots: Array<[number, number]>) =>
  rows.map((row, r) => {
    const cells = [...row]
    for (const [dr, dc] of dots) if (dr === r && cells[dc] === ' ') cells[dc] = '•'
    return cells.join('')
  })

/** The avatar's three rows for a mood at a frame. */
export const avatarFrame = (mood: Mood, tick: number, agentCount = 0): string[] => {
  switch (mood) {
    case 'idle':
      return IDLE[Math.floor(tick / 3) % IDLE.length]!
    case 'waiting':
      return WAITING[Math.floor(tick / 2) % WAITING.length]!
    case 'done':
      return tick % 2 === 0 ? BURST : STAR
    case 'agents': {
      const n = Math.max(1, Math.min(4, agentCount))
      const step = ORBIT.length / n
      const dots = Array.from({ length: n }, (_, i) => ORBIT[(tick + Math.round(i * step)) % ORBIT.length]!)
      return place(CROSS.map(r => r.replace(/[\\/]/g, ' ')), dots)
    }
    case 'working':
      return WORKING[tick % WORKING.length]!
  }
}

/** One glyph for the inline layout. */
export const avatarGlyph = (mood: Mood, tick: number) => {
  if (mood === 'idle') return '✻'
  if (mood === 'waiting') return tick % 2 === 0 ? '✻' : 'z'
  if (mood === 'done') return '✸'
  return ['✻', '✼', '✽', '✾'][tick % 4]!
}

export const moodLabel = (mood: Mood) =>
  ({ idle: 'idle', working: 'working…', agents: 'agents at work', waiting: 'waiting for limit reset', done: 'all done' })[mood]
