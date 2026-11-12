// The mod's long-lived controllers, shared between hooks and timers.

import type { LimitsController } from './limits'

/**
 * Controllers built in `session.start` from closures over that hook's `$`, so
 * the other hooks and the timers share one place for stored, timed work
 * (`$` itself may not be stored). A reload empties this; `session.start` runs
 * again then and fills it, so callers treat each entry as possibly missing.
 */
export const ctl: {
  /** Rate-limit merging and the auto-resume timer. */
  limits?: LimitsController
  /** Refreshes the git figures soon (debounced). */
  touchStats?: () => void
} = {}
