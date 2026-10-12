import { expect, test } from 'claude-code/testing'

const props = (isWorking: boolean) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

test('Pause hands Claude the stop-and-summarize instruction on the next tool result', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))

  const ui = await $.ui.mount({ plugin: 'pause-button', surface: 'terminal', component: 'AbovePrompt', props: props(true) })
  await ui.press({ key: 'pause' })

  const out = await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(JSON.stringify(out)).toContain('Still to do')
  await ui.unmount()
})

test('band stays hidden while idle and not paused', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  const ui = await $.ui.mount({ plugin: 'pause-button', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ key: 'pause' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})
