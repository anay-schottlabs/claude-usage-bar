import type { SessionRateLimit } from 'claude-code'

import type { Limit, Resume } from '../types'
import { formatReset } from './format'
import { RESUME_PROMPT } from './instructions'
import { STORE_LIMITS, storeResumeKey } from './state'

/** Two readings within this many ms of each other belong to the same window. */
const SAME_WINDOW_MS = 5 * 60 * 1000
/** Wait this long past the reset before resuming, so the reset has landed. */
export const RESUME_GRACE_MS = 30 * 1000
export const RETRY_MS = 2 * 60 * 1000

export const toLimit = (r: SessionRateLimit): Limit => {
  const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { kind: r.kind, percentUsed: r.percentUsed, ...(Number.isFinite(at) && { resetsAt: at }) }
}

type Stored = Record<string, { percentUsed: number; resetsAt?: number }>

/**
 * statusline.sh's cross-session rule: the store is shared by every session, but
 * each session's reading only refreshes after its own responses. Keep whichever
 * is newest: a later window wins, and within one window usage only goes up.
 * Returns the reading to show and whether `live` should be written back.
 */
export const mergeReading = (live: Limit | undefined, cached: Limit | undefined, now: number) => {
  if (cached?.resetsAt !== undefined && cached.resetsAt > now) {
    if (live?.resetsAt === undefined) return { value: cached, isWrite: false }
    if (cached.resetsAt > live.resetsAt + SAME_WINDOW_MS) return { value: cached, isWrite: false }
    if (Math.abs(cached.resetsAt - live.resetsAt) <= SAME_WINDOW_MS && cached.percentUsed > live.percentUsed) {
      return { value: { ...live, percentUsed: cached.percentUsed }, isWrite: false }
    }
  }
  return { value: live ?? cached, isWrite: live !== undefined }
}

const order = (k: string) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)

/** Every window merged with the store: what to show, and the store to write (if it changed). */
export const mergeAll = (live: Limit[], storedRaw: unknown, now: number) => {
  const stored = (typeof storedRaw === 'object' && storedRaw !== null ? storedRaw : {}) as Stored
  const kinds = new Set([...live.map(l => l.kind), ...Object.keys(stored)])
  const shown: Limit[] = []
  const nextStored: Stored = { ...stored }
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
    if (isWrite && JSON.stringify(raw) !== JSON.stringify({ percentUsed: value.percentUsed, resetsAt: value.resetsAt })) {
      nextStored[kind] = { percentUsed: value.percentUsed, ...(value.resetsAt !== undefined && { resetsAt: value.resetsAt }) }
      isDirty = true
    }
  }
  shown.sort((a, b) => order(a.kind) - order(b.kind))
  return { shown, store: isDirty ? nextStored : undefined }
}

/** The exhausted window that resets last, if any window is at its limit. */
export const exhausted = (list: Limit[], now: number): Limit | undefined =>
  list
    .filter(l => l.percentUsed >= 100 && (l.resetsAt === undefined || l.resetsAt > now))
    .sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0]

export const resumeLabel = (at: number, now: number) => formatReset(at, now, at - now > 20 * 3600 * 1000)

/** What the limits controller needs from the engine, as plain functions. */
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

export const makeLimits = (p: LimitPorts) => {
  let timer: { cancel: () => void } | undefined

  /** Folds this session's readings (or none: a sync tick) with the shared store. */
  const apply = async (live?: Limit[]) => {
    const now = await p.now()
    const shown = await p.getShown()
    const { shown: next, store } = mergeAll(live ?? shown, await p.storeGet(STORE_LIMITS), now)
    if (store && live !== undefined) await p.storeSet(STORE_LIMITS, store)
    if (JSON.stringify(next) !== JSON.stringify(shown)) await p.setShown(next)
  }

  const cancel = async () => {
    timer?.cancel()
    timer = undefined
    await p.setResume(null)
    await p.storeDelete(storeResumeKey(await p.sessionId()))
  }

  const arm = async (at: number, kind: string) => {
    timer?.cancel()
    const now = await p.now()
    await p.setResume({ at, kind })
    await p.storeSet(storeResumeKey(await p.sessionId()), { at, kind })
    timer = p.after(Math.max(1000, at - now), () => {
      void fire().catch(() => undefined)
    })
  }

  const fire = async () => {
    timer = undefined
    const now = await p.now()
    const readings = (await p.usage()).map(toLimit)
    await apply(readings)
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
    const hit = exhausted(readings.length > 0 ? readings : await p.getShown(), now)
    if (!hit) return
    const at = (hit.resetsAt ?? now + RETRY_MS) + RESUME_GRACE_MS
    await arm(at, hit.kind)
    p.toast(`Mission Control: limit reached, will resume at ${resumeLabel(at, now)}`)
  }

  /** Re-arms a resume a previous load of this session stored. */
  const restore = async () => {
    const stored = (await p.storeGet(storeResumeKey(await p.sessionId()))) as Partial<Resume> | undefined
    if (typeof stored?.at !== 'number') return
    const now = await p.now()
    if (now - stored.at > 24 * 3600 * 1000) return cancel()
    await arm(Math.max(stored.at, now + 5000), stored.kind ?? 'five_hour')
  }

  return { apply, arm, cancel, fire, onTurnError, restore }
}
