import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.UTC(2026, 10, 11, 18, 0, 0)

const pane = (placement: 'dock' | 'inline') =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'dashboard',
    surface: 'terminal',
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: 48,
      placement,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

type Usage = { kind: string; percentUsed: number; resetsAt?: string }[]

/** The engine beneath the mod: every call it makes answered from memory. */
const engine = (
  on: On,
  opts: { usage?: () => Usage; submitted?: string[]; contexts?: (readonly string[] | undefined)[] } = {},
) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'mission' } }))
  on('tool.register', () => ({ value: {} }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 200000 }, rateLimits: opts.usage?.() ?? [] },
  }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    opts.submitted?.push(e.text)
    opts.contexts?.push(e.context)
    return { text: e.text }
  })
  return clock
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

test('the task list and total bar follow TaskCreate and TaskUpdate', async ($, on) => {
  engine(on)
  let id = 0
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => ({ result: { task: { id: String(++id), subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  await $.session.start(START)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Extract types', description: 'd', activeForm: 'Extracting types' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Migrate API', description: 'd', activeForm: 'Migrating API' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', owner: 'api' })

  const ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /50% 1\/2 tasks$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✔ Extract types/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◐ Migrating API \(api\)/ })).toBeDefined()
  await ui.unmount()
})

test('a spawned agent shows its bar and what it is doing now', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start(START)

  // The kit fills what the engine would (tool_use_id, provider, ...).
  await $.agent.spawn({ prompt: 'do the api', description: 'API work', name: 'api' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b', agentId: 'a1' })

  const ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /^api .*planning…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ Edit auth\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agents at work · 1 agent$/ })).toBeDefined()
  await ui.unmount()
})

test('rate limits render as bars with their reset time', async ($, on) => {
  engine(on, {
    usage: () => [
      { kind: 'five_hour', percentUsed: 41, resetsAt: new Date(T0 + 2 * 3600e3).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(T0 + 3 * 86400e3).toISOString() },
    ],
  })
  await $.session.start(START)

  const ui = await $.ui.mount(pane('dock'))
  expect((await ui.find({ type: 'Text', text: /^5h/ }))?.text).toMatch(/41%$/)
  expect((await ui.find({ type: 'Text', text: /^7d/ }))?.text).toMatch(/12%$/)
  expect(await ui.find({ type: 'Text', text: /resets .*\(2h0m\)/ })).toBeDefined()
  await ui.unmount()
})

test('a turn that dies at the limit queues a resume that fires after the reset', async ($, on) => {
  const submitted: string[] = []
  let used = 100
  const resetsAt = new Date(T0 + 60_000).toISOString()
  const clock = engine(on, { usage: () => [{ kind: 'five_hour', percentUsed: used, resetsAt }], submitted })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start(START)

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'error' })
  const ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /Limit reached/ })).toBeDefined()
  expect(await ui.find({ key: 'cancel-resume' })).toBeDefined()

  used = 0
  await clock.advance(95_000)
  expect(submitted.some(t => t.startsWith('The rate limit has reset'))).toBe(true)
  await ui.unmount()
})

test('typing a prompt cancels a queued resume', async ($, on) => {
  const submitted: string[] = []
  const clock = engine(on, { submitted })
  on('command.run', () => ({ text: '' }))
  await $.session.start(START)

  await $.command.run({ command: 'mission', args: 'test-resume 30' } as never)
  await $.prompt.submit({ text: 'actually, do something else', origin: { kind: 'composer' } } as never)
  await clock.advance(60_000)

  expect(submitted.some(t => t.startsWith('The rate limit has reset'))).toBe(false)
  const ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /Limit reached/ })).toBeUndefined()
  await ui.unmount()
})

test('the inline layout is a compact summary', async ($, on) => {
  engine(on, { usage: () => [{ kind: 'five_hour', percentUsed: 41 }] })
  await $.session.start(START)

  const ui = await $.ui.mount(pane('inline'))
  expect(await ui.find({ type: 'Text', text: /idle · 5h 41%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /─ limits/ })).toBeUndefined()
  await ui.unmount()
})

test('every chat gets the workflow instructions', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const out = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const ids = out.sections.map(s => s.id)
  expect(ids).toEqual(['intro', 'mission-control:workflow'])
})

test('the main thread is the first agent row, and the total bar always shows', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start(START)

  // Before any work: main is ready and the bar reads 0%.
  let ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /^main .*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ ready/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0% ready$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no agents/ })).toBeUndefined()
  await ui.unmount()

  // During a turn: main shows what it is doing.
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /↳ Bash npm test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0% planning…$/ })).toBeDefined()
  await ui.unmount()
})

test('queuing three prompts mid-turn tells Claude to reorganise into tasks and agents', async ($, on) => {
  const contexts: (readonly string[] | undefined)[] = []
  engine(on, { contexts })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.turn.start({ text: 'first', turnId: 't1' })

  for (const text of ['one', 'two', 'three', 'four']) {
    await $.prompt.submit({ text, turnId: 't1', origin: { kind: 'composer' } } as never)
  }
  expect(contexts[0]).toBeUndefined()
  expect(contexts[1]).toBeUndefined()
  expect(contexts[2]?.join(' ')).toContain('queued 3 messages')
  expect(contexts[3]?.join(' ')).toContain('add it to the task list')

  const ui = await $.ui.mount(pane('dock'))
  expect(await ui.find({ type: 'Text', text: /4 queued/ })).toBeDefined()
  await ui.unmount()
})

test('the bar grows along the forecast checkpoints instead of sweeping', async ($, on) => {
  const clock = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })

  const plan = await $.tool.call({
    tool: 'mcp__mission-control__progress_plan',
    checkpoints: [
      { label: 'Read the code', estimateSeconds: 60 },
      { label: 'Make the edit', estimateSeconds: 60 },
    ],
  } as never)
  expect(JSON.stringify(plan)).toContain('2 checkpoints')

  const totalText = async () => {
    const ui = await $.ui.mount(pane('dock'))
    const t = (await ui.find({ type: 'Text', text: /% 0\/2|% 1\/2|% done/ }))?.text
    await ui.unmount()
    return t
  }

  expect(await totalText()).toMatch(/ 0% 0\/2 · Read the code/)
  await clock.advance(30_000)
  expect(await totalText()).toMatch(/ 25% 0\/2/)
  // Time alone stops short of the next checkpoint.
  await clock.advance(120_000)
  expect(await totalText()).toMatch(/ 45% 0\/2/)

  await $.tool.call({ tool: 'mcp__mission-control__progress_checkpoint' } as never)
  expect(await totalText()).toMatch(/ 50% 1\/2 · Make the edit/)
  await $.tool.call({ tool: 'mcp__mission-control__progress_checkpoint' } as never)
  expect(await totalText()).toMatch(/100% done/)

  const check = await $.tool.check({ tool: 'mcp__mission-control__progress_checkpoint' } as never)
  expect(check.decision).toBe('allow')
})
