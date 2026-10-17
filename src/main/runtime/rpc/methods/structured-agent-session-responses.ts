import type { z } from 'zod'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import { sessionManageActorId } from '../../../session-manage/session-manage-caller'
import type { RpcContext } from '../core'
import { requireStructuredHost, structuredCallerFor } from './structured-agent-session-gate'
import type { RespondParams } from './structured-agent-session-schemas'

function respond(
  context: RpcContext,
  params: z.infer<typeof RespondParams>,
  kind: 'approval' | 'question',
  actor?: SessionManageActor
) {
  const caller = actor
    ? { callerKey: `session-manage:${sessionManageActorId(actor)}` }
    : structuredCallerFor(context)
  return requireStructuredHost(context).respondToPrompt(caller, { ...params, kind })
}

export const respondToApproval = (
  context: RpcContext,
  params: z.infer<typeof RespondParams>,
  actor?: SessionManageActor
) => respond(context, params, 'approval', actor)

export const respondToQuestion = (
  context: RpcContext,
  params: z.infer<typeof RespondParams>,
  actor?: SessionManageActor
) => respond(context, params, 'question', actor)
