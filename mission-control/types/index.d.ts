export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
  owner?: string
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  /** The Agent call's `name`, else its description: what task `owner`s match. */
  name: string
  description: string
  type: string
  status: AgentStatus
  /** One-line summary of the tool call it is running now, e.g. "Edit auth.ts". */
  current: string
  toolCount: number
  startedAt: number
}

export type Limit = {
  /** `five_hour`, `seven_day`, ... */
  kind: string
  percentUsed: number
  /** Epoch milliseconds. */
  resetsAt?: number
}

export type Stats = {
  branch?: string
  ahead?: number
  behind?: number
  pushed?: number
  unpushed?: number
  /** Commits on HEAD when there is no upstream. */
  commits?: number
  added: number
  removed: number
  codeLines?: number
  isRepo: boolean
}

/** The main conversation, drawn as the first agent row. */
export type MainRow = {
  /** `running` during a main-loop turn, `done` after one, `idle` before the first. */
  phase: 'idle' | 'running' | 'done'
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

export type Resume = {
  /** Epoch milliseconds the resume fires at. */
  at: number
  kind: string
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      tasks: Shaped<Task[]>
      agents: Shaped<AgentRow[]>
      limits: Shaped<Limit[]>
      stats: Shaped<Stats>
      frame: number
      isBusy: boolean
      resume: Shaped<Resume | null>
      main: Shaped<MainRow>
      /** Prompts the person queued during the running main turn. */
      queued: number
      /** Progress plans by loop: `main` or a subagent's id. */
      plans: Shaped<Record<string, Plan>>
    }
  }
}
