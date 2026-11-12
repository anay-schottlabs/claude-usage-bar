// Progress plans: each loop forecasts its checkpoints, and the bar grows
// toward the next one as its estimated time passes, then jumps to it when
// the checkpoint is reported.

import type { Plan } from '../types'

export const PLAN_TOOL = 'progress_plan'
export const CHECKPOINT_TOOL = 'progress_checkpoint'
export const PLAN_TOOL_FULL = 'mcp__mission-control__progress_plan'
export const CHECKPOINT_TOOL_FULL = 'mcp__mission-control__progress_checkpoint'

/** Within a segment the bar never passes this share before the checkpoint lands. */
const SEGMENT_CAP = 0.9

export const PLAN_SPEC = {
  name: PLAN_TOOL,
  description:
    'Forecast the work ahead for the progress bar the user watches. Call it before starting any request (and, in a subagent, before starting your task): list the ordered checkpoints that take the work to completion, each with an honest estimate of how long it takes. Call it again if the scope changes: checkpoints already reached are kept and the new list replaces the rest.',
  inputSchema: {
    type: 'object',
    properties: {
      checkpoints: {
        type: 'array',
        minItems: 1,
        description: 'Ordered checkpoints from now until the work is complete.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'What is done at this checkpoint, e.g. "API handlers migrated".' },
            estimateSeconds: { type: 'number', description: 'Estimated seconds from the previous checkpoint to this one.' },
          },
          required: ['label', 'estimateSeconds'],
        },
      },
    },
    required: ['checkpoints'],
  },
  isDeferred: false,
} as const

export const CHECKPOINT_SPEC = {
  name: CHECKPOINT_TOOL,
  description:
    'Report that the next checkpoint of your progress_plan is reached, so the user\'s progress bar moves forward. Call it as soon as each checkpoint is done.',
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string', description: 'The checkpoint reached (optional, for the log).' } },
  },
  isDeferred: false,
} as const

type PlanInput = { checkpoints?: { label?: unknown; estimateSeconds?: unknown }[] }

/** A new or revised plan: reached checkpoints stay, the rest is replaced. */
export const applyPlan = (prev: Plan | undefined, input: PlanInput, now: number): Plan => {
  const next = (input.checkpoints ?? [])
    .map(c => ({
      label: typeof c.label === 'string' && c.label.trim() !== '' ? c.label.trim() : 'step',
      seconds: Math.max(5, Number(c.estimateSeconds) || 60),
    }))
    .slice(0, 50)
  const kept = prev && !prev.isComplete ? prev.checkpoints.slice(0, prev.reached) : []
  return {
    checkpoints: [...kept, ...next],
    reached: kept.length,
    segmentStartedAt: prev && !prev.isComplete ? prev.segmentStartedAt : now,
    isComplete: next.length === 0,
  }
}

export const applyCheckpoint = (prev: Plan, now: number): Plan => {
  const reached = Math.min(prev.checkpoints.length, prev.reached + 1)
  return { ...prev, reached, segmentStartedAt: now, isComplete: reached >= prev.checkpoints.length }
}

export const completePlan = (prev: Plan): Plan => ({ ...prev, reached: prev.checkpoints.length, isComplete: true })

/** The plan's share done (0..1): reached checkpoints plus time into the current one. */
export const planFraction = (plan: Plan, now: number) => {
  const total = plan.checkpoints.reduce((n, c) => n + c.seconds, 0)
  if (plan.isComplete || plan.reached >= plan.checkpoints.length || total <= 0) return 1
  const done = plan.checkpoints.slice(0, plan.reached).reduce((n, c) => n + c.seconds, 0)
  const cur = plan.checkpoints[plan.reached]!.seconds
  const partial = cur * Math.min(SEGMENT_CAP, Math.max(0, now - plan.segmentStartedAt) / (cur * 1000))
  return (done + partial) / total
}

/** Estimated seconds left, from the forecast. */
export const planRemaining = (plan: Plan, now: number) => {
  const total = plan.checkpoints.reduce((n, c) => n + c.seconds, 0)
  return Math.max(0, Math.round(total * (1 - planFraction(plan, now))))
}

/** "2/5 · Migrating handlers" — the plan's place, for a row's label. */
export const planLabel = (plan: Plan) => {
  const n = plan.checkpoints.length
  if (plan.isComplete || plan.reached >= n) return `${n}/${n}`
  return `${plan.reached}/${n} · ${plan.checkpoints[plan.reached]!.label}`
}
