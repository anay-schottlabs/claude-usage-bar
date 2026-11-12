// Pure text and number helpers shared by the pane and the trackers. Nothing
// here touches `$` or the engine, so every function is safe to unit-test alone.
// (Tool-call phrasing lives in ./activity.ts.)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Pins `n` into the range [lo, hi]. */
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * A progress bar `width` cells wide for a 0..1 fraction, split into its filled
 * (█) and empty (░) halves so the caller can color them differently.
 */
export const bar = (fraction: number, width: number) => {
  const w = Math.max(1, width)
  const filled = Math.round(clamp(fraction, 0, 1) * w)
  return { filled: '█'.repeat(filled), empty: '░'.repeat(w - filled) }
}

/** Rounds and adds thousands separators: 1234567.8 → "1,234,568". */
export const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** "3:45 PM" in the local time zone. */
const clock12 = (d: Date) => {
  const h = d.getHours() % 12 || 12
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

/** Compact time left, coarsest units only: "2d 4h", "2h10m", "45m", "30s". Negative counts as zero. */
export const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m`
  return `${s}s`
}

/**
 * When a rate-limit window resets, plus the time left: "3:45 PM (2h10m)", or
 * with `withDate` "Thu Nov 13, 3:45 PM (2d 4h)". Mirrors statusline.sh's format_reset.
 */
export const formatReset = (resetsAt: number, now: number, withDate: boolean) => {
  const d = new Date(resetsAt)
  const time = withDate ? `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock12(d)}` : clock12(d)
  return `${time} (${countdown(resetsAt - now)})`
}

/** Fits `text` into `width` columns, ending with "…" when it had to be cut. */
export const truncate = (text: string, width: number) =>
  width <= 0 ? '' : text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'

/** Short display name of a rate-limit window kind: "five_hour" → "5h", "seven_day" → "7d". */
export const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind.replace(/_/g, ' ')
