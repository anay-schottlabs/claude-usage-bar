// running: normal. pausing: Pause pressed, instruction not yet delivered.
// pause-sent: Claude has the instruction and is wrapping up. paused: waiting for Continue.
export type PauseMode = 'running' | 'pausing' | 'pause-sent' | 'paused'

declare module 'claude-code' {
  interface PluginState {
    'pause-button': { mode: PauseMode }
  }
}
