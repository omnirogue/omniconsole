import { z } from 'zod'
import { taskId } from './console-workflow-schemas'

/**
 * The hub's canonical lifecycle verbs, and the request the desktop sends for one.
 *
 * `done` is deliberately absent: completion is not a rail move. It runs through the
 * board PATCH and the hub's evidence gate, so a card finished from the Kanban goes the
 * same way as a card finished anywhere else.
 */
export const TASK_LIFECYCLE_ACTIONS = [
  'backlog',
  'ready',
  'start',
  'wait',
  'resume',
  'submit_for_review'
] as const
export type TaskLifecycleAction = (typeof TASK_LIFECYCLE_ACTIONS)[number]

const text = z.string().trim().min(1)
export const taskTransitionRequest = z
  .object({
    taskId,
    action: z.enum(TASK_LIFECYCLE_ACTIONS),
    expectedRevision: z.number().int().nonnegative(),
    nextAction: text.max(8000).optional(),
    reason: text.max(8000).optional(),
    resultRef: text.max(2000).optional(),
    waitingOn: text.max(2000).optional(),
    followUpAt: text.max(64).optional(),
    deferUntil: text.max(64).optional()
  })
  .strict()
