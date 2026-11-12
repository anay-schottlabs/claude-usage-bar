export const WORKFLOW_SECTION = {
  id: 'mission-control:workflow',
  scope: 'session',
  text: [
    '# Mission Control dashboard',
    'The user watches a dashboard beside this chat that is built from your task list and your subagents, including an overall progress bar. Keep it accurate:',
    '- Progress forecast: before starting any request, and in a subagent before starting its task, call mcp__mission-control__progress_plan with the ordered checkpoints that take the work to completion, each with an honest estimateSeconds (your best guess of how long it takes from the checkpoint before). Then call mcp__mission-control__progress_checkpoint the moment each checkpoint is reached. The user\'s progress bar grows along this forecast, so keep it truthful: re-plan if the scope changes (reached checkpoints are kept). For a big change, include checkpoints for the agents\' work finishing. A one-line answer needs no plan.',
    '- For any request that takes more than one step, start by creating a task list with TaskCreate, one task per step, each with a short `subject` and an `activeForm`. TaskUpdate a task to `in_progress` when you start it and to `completed` as soon as it is done, so the task list stays current. A single quick action (one edit, one answer) needs no task list.',
    '- For a big change (it touches 3 or more files, spans several areas of the codebase, or takes 4 or more distinct steps), also run the independent parts in parallel with the Agent tool. Give every agent a short lowercase `name` (e.g. "api", "tests") and set each task\'s `owner` to the name of the agent doing it (TaskUpdate). Tasks you do yourself get owner "main". Do sequential or tightly coupled parts yourself. Subagents update the tasks they own the same way.',
    '- If the conversation shows work that stopped partway (for example after a rate limit), check TaskList first and resume from the first incomplete task, spawning agents again for incomplete tasks whose agents did not finish.',
  ].join('\n'),
} as const

export const RESUME_PROMPT =
  'The rate limit has reset. Continue the interrupted work: check TaskList and the state of any agents, then resume from the first incomplete task, spawning agents again for tasks whose agents did not finish.'

/** Queued prompts in one turn at which Claude is told to reorganise. */
export const QUEUE_THRESHOLD = 3

/** Context attached to a queued prompt once the queue reaches the threshold. */
export const queueContext = (count: number) =>
  count === QUEUE_THRESHOLD
    ? [
        `[Mission Control] The user has queued ${count} messages while you were working.`,
        'At the earliest safe stopping point (leave nothing half-edited), pause your current approach and reorganise:',
        'turn the remaining work plus every queued request into the task list (TaskCreate for new items, TaskUpdate for existing ones, and mark what is already done),',
        'then spawn named agents (Agent with `name`; set each task\'s `owner`) for the tasks that can run in parallel, and continue with the rest yourself.',
      ].join(' ')
    : `[Mission Control] Queued message ${count} this turn: add it to the task list (and to an agent if it fits one) rather than handling it ad hoc.`
