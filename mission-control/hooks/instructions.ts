export const WORKFLOW_SECTION = {
  id: 'mission-control:workflow',
  scope: 'session',
  text: [
    '# Mission Control dashboard',
    'The user watches a dashboard beside this chat that is built from your task list and your subagents. Keep it accurate:',
    '- For a big change (it touches 3 or more files, spans several areas of the codebase, or takes 4 or more distinct steps): before editing, create a task list with TaskCreate, one task per unit of work, each with a short `subject` and an `activeForm`. Then run the independent parts in parallel with the Agent tool, giving every agent a short lowercase `name` (e.g. "api", "tests") and setting each task\'s `owner` to the name of the agent doing it (TaskUpdate). Do sequential or tightly coupled parts yourself.',
    '- Keep the task list current as work moves: TaskUpdate a task to `in_progress` when work on it starts and to `completed` as soon as it is done. Subagents update the tasks they own the same way.',
    '- For a small change (a single file, a quick fix, a question): just do it, with no task list and no agents.',
    '- If the conversation shows work that stopped partway (for example after a rate limit), check TaskList first and resume from the first incomplete task, spawning agents again for incomplete tasks whose agents did not finish.',
  ].join('\n'),
} as const

export const RESUME_PROMPT =
  'The rate limit has reset. Continue the interrupted work: check TaskList and the state of any agents, then resume from the first incomplete task, spawning agents again for tasks whose agents did not finish.'
