// Shared names: the pane's id and title, and the `$.store` keys. Atom keys are
// not here because each module must declare its atoms with literal keys.

/** The pane's `ui.open` id: the pane module mounts against it. */
export const PANE = 'dashboard'
export const TITLE = 'Mission Control'

/** `$.store` key of the rate-limit readings every session on this machine shares. */
export const STORE_LIMITS = 'limits'
/** `$.store` key of one session's queued auto-resume, so a reload can re-arm it. */
export const storeResumeKey = (sessionId: string) => `resume:${sessionId}`
