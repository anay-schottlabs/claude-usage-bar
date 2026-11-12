// Rate limits and auto-resume. Readings from this session are merged with a
// store every session on the machine shares (so an idle session still shows
// current figures), and a main turn that dies at 100% arms a timer that
// resubmits the work once the window resets. Everything engine-side comes in
// through `LimitPorts`, so this file never touches `$`.

import type { SessionRateLimit } from 'claude-code'

import type { Limit, Resume } from '../types'
import { formatReset } from './format'
import { RESUME_PROMPT } from './instructions'
import { STORE_LIMITS, storeResumeKey } from './state'

/** Two readings whose resets lie within this many ms belong to the same window. */
const SAME_WINDOW_MS = 5 * 60 * 1000
/** Wait this long past the reset before resuming, so the reset has landed. */
const RESUME_GRACE_MS = 30 * 1000
/** Re-check this often when a window is exhausted but names no reset. */
const RETRY_MS = 2 * 60 * 1000
/** A stored resume older than this is from another day's work: dropped, not fired. */
const STALE_RESUME_MS = 24 * 3600 * 1000

/** The engine's reading as state: ISO reset time to epoch ms (dropped if unparsable). */
export const toLimit = (r: SessionRateLimit): Limit => {
  const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { kind: r.kind, percentUsed: r.percentUsed, ...(Number.isFinite(at) && { resetsAt: at }) }
}

/** The shared store's shape: one reading per window kind. */
type Stored = Record<string, { percentUsed: number; resetsAt?: number }>

/**
 * statusline.sh's cross-session rule: the store is shared by every session, but
 * each session's reading only refreshes after its own responses. Keep whichever
 * is newest: a later window wins, and within one window usage only goes up.
 * Returns the reading to show and whether `live` should be written back.
 */
const mergeReading = (live: Limit | undefined, cached: Limit | undefined, now: number) => {
  if (cached?.resetsAt !== undefined && cached.resetsAt > now) {
    if (live?.resetsAt === undefined) return { value: cached, isWrite: false }
    // Another session has seen a later window than ours.
    if (cached.resetsAt > live.resetsAt + SAME_WINDOW_MS) return { value: cached, isWrite: false }
    // Same window, another session has seen more usage.
    if (Math.abs(cached.resetsAt - live.resetsAt) <= SAME_WINDOW_MS && cached.percentUsed > live.percentUsed) {
      return { value: { ...live, percentUsed: cached.percentUsed }, isWrite: false }
    }
  }
  return { value: live ?? cached, isWrite: live !== undefined }
}

/** Display order: the five-hour window, the weekly one, then anything else. */
const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)

/** Every window merged with the store: what to show, and the store to write (if it changed). */
const mergeAll = (live: Limit[], storedRaw: unknown, now: number) => {
  const stored = (typeof storedRaw === 'object' && storedRaw !== null ? storedRaw : {}) as Stored
  const kinds = new Set([...live.map(l => l.kind), ...Object.keys(stored)])
  const shown: Limit[] = []
  const updated: Stored = { ...stored }
  let isDirty = false
  for (const kind of kinds) {
    const raw = stored[kind]
    const { value, isWrite } = mergeReading(
      live.find(l => l.kind === kind),
      raw ? { kind, ...raw } : undefined,
      now,
    )
    if (!value) continue
    shown.push(value)
    const entry = { percentUsed: value.percentUsed, ...(value.resetsAt !== undefined && { resetsAt: value.resetsAt }) }
    if (isWrite && JSON.stringify(raw) !== JSON.stringify(entry)) {
      updated[kind] = entry
      isDirty = true
    }
  }
  shown.sort((a, b) => order(a.kind) - order(b.kind))
  return { shown, store: isDirty ? updated : undefined }
}

/** The exhausted window that resets last, if any window is at its limit. */
const exhausted = (list: Limit[], now: number): Limit | undefined =>
  list
    .filter(l => l.percentUsed >= 100 && (l.resetsAt === undefined || l.resetsAt > now))
    .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]

/** When a resume fires, for the pane and toasts: the date too once it is a day off. */
export const resumeLabel = (at: number, now: number) => formatReset(at, now, at - now > 20 * 3600 * 1000)

/** What the limits controller needs from the engine, as plain functions over `$`. */
export type LimitPorts = {
  now: () => Promise<number>
  sessionId: () => Promise<string>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  storeDelete: (key: string) => Promise<void>
  getShown: () => Promise<Limit[]>
  setShown: (list: Limit[]) => Promise<unknown>
  setResume: (r: Resume | null) => Promise<unknown>
  usage: () => Promise<readonly SessionRateLimit[]>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  submit: (text: string) => void
  toast: (text: string) => void
}

export type LimitsController = ReturnType<typeof makeLimits>

/**
 * The limits controller: merging readings into the `limits` atom, and the
 * auto-resume timer. The resume is mirrored to the `resume` atom (the pane's
 * banner and cancel button) and to the store, so a reload can re-arm it.
 */
export const makeLimits = (p: LimitPorts) => {
  let timer: { cancel: () => void } | undefined
  // Bumped by every arm and cancel. Each await below can interleave with
  // another call (the person typing cancels while a resume is being armed or
  // firing), so work that resumes after an await checks it is still current;
  // without this a cancelled resume could still submit, or two timers live.
  let generation = 0

  /** Folds this session's readings (or none: a sync tick) with the shared store. */
  const apply = async (live?: Limit[]) => {
    const now = await p.now()
    const shown = await p.getShown()
    const { shown: merged, store } = mergeAll(live ?? shown, await p.storeGet(STORE_LIMITS), now)
    // Only fresh readings are written back: a sync tick merely re-reads.
    if (store && live !== undefined) await p.storeSet(STORE_LIMITS, store)
    if (JSON.stringify(merged) !== JSON.stringify(shown)) await p.setShown(merged)
  }

  /** Drops any queued resume: the timer, the pane's banner and the stored copy. */
  const cancel = async () => {
    generation++
    timer?.cancel()
    timer = undefined
    await p.setResume(null)
    await p.storeDelete(storeResumeKey(await p.sessionId()))
  }

  /** Queues a resume at `at` (epoch ms) for window `kind`, replacing any other. */
  const arm = async (at: number, kind: string) => {
    const mine = ++generation
    timer?.cancel()
    timer = undefined
    const now = await p.now()
    if (mine !== generation) return
    await p.setResume({ at, kind })
    await p.storeSet(storeResumeKey(await p.sessionId()), { at, kind })
    if (mine !== generation) return
    timer = p.after(Math.max(1000, at - now), () => {
      void fire(mine).catch(() => undefined)
    })
  }

  /** The timer ran out: resume if every window has reset, else wait for the next reset. */
  const fire = async (armed: number) => {
    if (armed !== generation) return
    timer = undefined
    const now = await p.now()
    const readings = (await p.usage()).map(toLimit)
    await apply(readings)
    // Cancelled or re-armed while reading the limits: that call decides.
    if (armed !== generation) return
    const still = exhausted(readings, now)
    if (still) {
      // Not reset yet: try again at its reset, or shortly when it names none.
      const at = still.resetsAt !== undefined && still.resetsAt > now ? still.resetsAt + RESUME_GRACE_MS : now + RETRY_MS
      await arm(at, still.kind)
      return
    }
    await cancel()
    p.toast('Mission Control: rate limit reset, resuming work')
    p.submit(RESUME_PROMPT)
  }

  /** A main-loop turn died on an error: if a window is at 100%, queue the work for its reset. */
  const onTurnError = async () => {
    const now = await p.now()
    const readings = (await p.usage()).map(toLimit)
    await apply(readings)
    // No fresh readings (off a subscription, say): fall back on what is shown.
    const hit = exhausted(readings.length > 0 ? readings : await p.getShown(), now)
    if (!hit) return
    const at = (hit.resetsAt ?? now + RETRY_MS) + RESUME_GRACE_MS
    await arm(at, hit.kind)
    p.toast(`Mission Control: limit reached, will resume at ${resumeLabel(at, now)}`)
  }

  /** Re-arms a resume a previous load of this session stored (at least 5s out). */
  const restore = async () => {
    const stored = (await p.storeGet(storeResumeKey(await p.sessionId()))) as Partial<Resume> | undefined
    if (typeof stored?.at !== 'number') return
    const now = await p.now()
    if (now - stored.at > STALE_RESUME_MS) return cancel()
    await arm(Math.max(stored.at, now + 5000), stored.kind ?? 'five_hour')
  }

  return { apply, arm, cancel, onTurnError, restore }
}
