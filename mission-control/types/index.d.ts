// Shapes of Mission Control's state. Every atom the mod keeps is listed under
// `PluginState['mission-control']` at the bottom; the types above it are the
// values those atoms hold. Changing a shape here needs a new shape tag on
// every atom declaration of that key (e.g. `agents-1` -> `agents-2`).

/** A task's place in Claude Code's task list. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One entry of the session's task list, mirrored from the task tools. */
export type Task = {
  id: string
  /** Imperative title, e.g. "Run tests". */
  subject: string
  /** Present-tense form shown while in progress, e.g. "Running tests". */
  activeForm?: string
  status: TaskStatus
  /** The agent name that owns it; unset (or unknown names) count as the main thread's. */
  owner?: string
}

/** Lifecycle of a subagent: `killed` is a stop from outside, `failed` an error. */
export type AgentStatus = 'running' | 'completed' | 'failed' | 'killed'

/** One subagent spawned this session. */
export type AgentRow = {
  /** The runtime's agent id; also the `plans` key of its forecast. */
  id: string
  /** The Agent call's `name`, else its description: what task `owner`s match. */
  name: string
  description: string
  /** Subagent type, e.g. `general-purpose`. */
  type: string
  status: AgentStatus
  /** Plain-English summary of the tool call it is running now, e.g. "Editing auth.ts". */
  current: string
  /** Tool calls made so far. */
  toolCount: number
  /** Epoch milliseconds. */
  startedAt: number
}

/** One rate-limit window's latest reading. */
export type Limit = {
  /** `five_hour`, `seven_day`, ... */
  kind: string
  /** 0..100. */
  percentUsed: number
  /** Epoch milliseconds the window resets at. */
  resetsAt?: number
}

/** Git and code stats for the session's working directory. Optional fields are absent when git can't answer. */
export type Stats = {
  branch?: string
  /** Commits ahead of / behind the upstream; only with an upstream. */
  ahead?: number
  behind?: number
  /** Commits on the upstream, and commits on HEAD not yet pushed; only with an upstream. */
  pushed?: number
  unpushed?: number
  /** Commits on HEAD when there is no upstream. */
  commits?: number
  /** Uncommitted lines added and removed against HEAD. */
  added: number
  removed: number
  /** Lines across source files in the working tree. */
  codeLines?: number
  isRepo: boolean
}

/** The main conversation, drawn as the first agent row. */
export type MainRow = {
  /** `running` during a main-loop turn, `done` after one, `idle` before the first. */
  phase: 'idle' | 'running' | 'done'
  /** What the main thread is doing now; empty between turns. */
  current: string
  /** Tool calls in the current (or last) piece of work. */
  toolCount: number
}

/** A loop's own forecast: ordered checkpoints, each with its estimated length. */
export type Plan = {
  checkpoints: { label: string; seconds: number }[]
  /** How many checkpoints are reached, in order. */
  reached: number
  /** Epoch ms the current checkpoint's segment began. */
  segmentStartedAt: number
  isComplete: boolean
}

/** A queued auto-resume after a turn died at a rate limit. */
export type Resume = {
  /** Epoch milliseconds the resume fires at. */
  at: number
  /** The limit window that stopped the work, e.g. `five_hour`. */
  kind: string
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      /** The session's task list. */
      tasks: Shaped<Task[]>
      /** Every subagent spawned this session, oldest first. */
      agents: Shaped<AgentRow[]>
      /** Latest reading per rate-limit window, synced across sessions. */
      limits: Shaped<Limit[]>
      /** Git and code stats, refreshed on a timer. */
      stats: Shaped<Stats>
      /** Animation counter, bumped every tick; drives the banner and spinner. */
      frame: number
      /** True while a main-loop turn runs. */
      isBusy: boolean
      /** The queued auto-resume, or null when none is pending. */
      resume: Shaped<Resume | null>
      /** The main thread's row. */
      main: Shaped<MainRow>
      /** Prompts the person queued during the running main turn. */
      queued: number
      /** Progress plans by loop: `main` or a subagent's id. */
      plans: Shaped<Record<string, Plan>>
    }
  }
}
