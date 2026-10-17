// `sessionSteward.status` / `sessionSteward.finished`: what the steward's rules loop did, what it
// could not move, and the result cards of what it archived. Read-only; the window and the local
// CLI only, like the organization history.

import { z } from 'zod'
import {
  SESSION_STEWARD_STATUS_RPC,
  type SessionStewardFinishedResult,
  type SessionStewardStatus
} from '../../../../shared/session-steward-status'
import { getSessionSteward } from '../../../session-steward/steward-runtime'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationLocalReader } from './session-organization'

export const SESSION_STEWARD_NOT_RUNNING = 'The session steward is not running on this computer.'

const StatusParams = z.object({}).strict().optional()
const FinishedParams = z
  .object({
    /** Epoch ms: only cards archived at or after it. */
    since: z.number().int().min(0).optional()
  })
  .strict()
  .optional()

export const SESSION_STEWARD_STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_STEWARD_STATUS_RPC.status,
    params: StatusParams,
    handler: async (_params, context): Promise<SessionStewardStatus> => {
      assertOrganizationLocalReader(context)
      return (
        getSessionSteward()?.status() ?? {
          off: SESSION_STEWARD_NOT_RUNNING,
          stalled: [],
          silent: [],
          activity: [],
          prompts: { today: 0 }
        }
      )
    }
  }),
  defineMethod({
    name: SESSION_STEWARD_STATUS_RPC.finished,
    params: FinishedParams,
    handler: async (params, context): Promise<SessionStewardFinishedResult> => {
      assertOrganizationLocalReader(context)
      const steward = getSessionSteward()
      return { cards: steward ? await steward.finished(params?.since ?? 0) : [] }
    }
  })
]
