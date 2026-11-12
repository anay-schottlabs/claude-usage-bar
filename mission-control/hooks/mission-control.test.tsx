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
const engine = (on: On, opts: { usage?: () => Usage; submitted?: string[] } = {}) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'mission' } }))
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
  expect((await ui.find({ type: 'Text', text: /^Total/ }))?.text).toMatch(/50%$/)
  expect(await ui.find({ type: 'Text', text: /✔ Extract types/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◐ Migrating API \(api\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 tasks done/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^api .*1 tools/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↳ Edit auth\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 agent running/ })).toBeDefined()
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
