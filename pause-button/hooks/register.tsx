import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PauseMode } from '../types'

const mode = atom({ plugin: 'pause-button', key: 'mode' } as const, 'running' as PauseMode)

const PAUSE_INSTRUCTION = [
  '[The user pressed Pause.] Find the earliest safe stopping point: do only the minimum',
  'needed so nothing is left broken or half-edited, and start no new work. Then stop',
  'calling tools and reply with exactly two sections:',
  '"## Done so far" (what was completed) and',
  '"## Still to do" (concrete remaining steps, specific enough to resume from).',
].join(' ')

const CONTINUE_PROMPT =
  'Continue the paused work, picking up from the "Still to do" list in your pause summary.'

export const register: Register = on => {
  // Deliver the pause instruction alongside the result of the next tool call,
  // so Claude reads it mid-turn without the in-flight call being refused.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, mode)) !== 'pausing' || 'deny' in result && result.deny !== undefined) {
      return result
    }
    await update($, mode, () => 'pause-sent' as PauseMode)
    return { ...result, context: [...(result.context ?? []), PAUSE_INSTRUCTION] }
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out

    const current = await read($, mode)
    if (e.reason === 'aborted' || e.reason === 'error') {
      // The user interrupted (or the turn died): drop any pending pause.
      if (current === 'pausing' || current === 'pause-sent') {
        await update($, mode, () => 'running' as PauseMode)
      }
    } else if (current === 'pause-sent') {
      await update($, mode, () => 'paused' as PauseMode)
    } else if (current === 'pausing') {
      // The turn ended before another tool call; ask for the summaries directly.
      await update($, mode, () => 'pause-sent' as PauseMode)
      void $.prompt.submit({ text: PAUSE_INSTRUCTION })
    }
    return out
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, mode)
    if (e.props.hasSurvey || (current === 'running' && !e.props.isWorking)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    if (current === 'running') {
      return (
        <Box>
          <Button
            key="pause"
            label="⏸ Pause"
            onPress={() => update($, mode, () => 'pausing' as PauseMode)}
          />
        </Box>
      )
    }

    if (current === 'paused' && !e.props.isWorking) {
      return (
        <Box>
          <Button
            key="continue"
            label="▶ Continue"
            onPress={async () => {
              await update($, mode, () => 'running' as PauseMode)
              void $.prompt.submit({ text: CONTINUE_PROMPT })
            }}
          />
          <Text dimColor> Paused. Summary above.</Text>
        </Box>
      )
    }

    return (
      <Box>
        <Text dimColor>⏸ Pausing: finding the earliest stopping point…</Text>
      </Box>
    )
  })
}
