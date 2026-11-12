import type { LimitsController } from './limits'

/**
 * Controllers built in `session.start` from closures over that hook's `$`, so
 * the other hooks and the timers share one place for stored, timed work.
 * A reload empties this; `session.start` runs again then and fills it.
 */
export const ctl: {
  limits?: LimitsController
  /** Refreshes the git figures soon (debounced). */
  touchStats?: () => void
} = {}
