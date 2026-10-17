import { z } from 'zod'
import {
  SESSION_WHEN_IDLE_MAX_MS,
  SESSION_WHEN_IDLE_MIN_MS
} from '../../../../shared/session-pending-delivery-types'
import { SessionManageRestartParams, SessionManageTarget } from './session-manage-schemas'

const { reason, request, dryRun } = SessionManageRestartParams.shape

export const SessionManageResumeParams = z
  .object({ ref: z.string().trim().min(3).max(600), reason, request, dryRun })
  .strict()

export const SessionManageContinueWhenIdleParams = z
  .object({
    target: SessionManageTarget,
    text: z.string().min(1).max(30_000),
    withinMs: z
      .number()
      .int()
      .min(SESSION_WHEN_IDLE_MIN_MS)
      .max(SESSION_WHEN_IDLE_MAX_MS)
      .optional(),
    /** Hold the call open until it is sent or its window ends. */
    wait: z.boolean().optional(),
    /** `assign` sends it as a new task (`session assign --when-idle`). */
    kind: z.enum(['continue', 'assign']).optional(),
    reason,
    request,
    dryRun
  })
  .strict()

export const SessionManagePendingParams = z
  .object({
    all: z.boolean().optional(),
    cancel: z.string().trim().min(1).max(200).optional()
  })
  .strict()
