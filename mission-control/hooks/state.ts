export const PLUGIN = 'mission-control'
export const PANE = 'dashboard'
export const TITLE = 'Mission Control'

/** `$.store` keys: shared by every session on this machine. */
export const STORE_LIMITS = 'limits'
export const storeResumeKey = (sessionId: string) => `resume:${sessionId}`
