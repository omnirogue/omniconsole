// `sessionDecisions.*`: the Work box's "Needs You — Questions" list. Answering a question is the
// person's decision at their own interface, so every method admits only the desktop renderer or
// a paired device (`assertSessionOutcomeUser`), never an agent or a dispatched worker.

import {
  SESSION_DECISIONS_RPC,
  SessionAnswerWaitsParamsSchema,
  SessionDecisionKeyParamsSchema,
  SessionDecisionsListParamsSchema,
  type SessionAnswerWaitsResult,
  type SessionDecisionsResult
} from '../../../../shared/session-decisions'
import { readAnswerWaits } from '../../../answer-delivery/answer-wait'
import {
  getSessionDecisionStore,
  listSessionDecisions
} from '../../../session-questions/session-decision-wiring'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod, type RpcMethod } from '../core'

export const SESSION_DECISIONS_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_DECISIONS_RPC.list,
    params: SessionDecisionsListParamsSchema,
    handler: async (_params, context): Promise<SessionDecisionsResult> => {
      assertSessionOutcomeUser(context)
      return { decisions: listSessionDecisions() }
    }
  }),
  defineMethod({
    name: SESSION_DECISIONS_RPC.resolve,
    params: SessionDecisionKeyParamsSchema,
    handler: async ({ key }, context): Promise<{ removed: boolean }> => {
      assertSessionOutcomeUser(context)
      return { removed: getSessionDecisionStore()?.remove(key) ?? false }
    }
  }),
  defineMethod({
    name: SESSION_DECISIONS_RPC.dismiss,
    params: SessionDecisionKeyParamsSchema,
    handler: async ({ key }, context): Promise<{ removed: boolean }> => {
      assertSessionOutcomeUser(context)
      const store = getSessionDecisionStore()
      // Why: a live question still holds its session; only an ended one can be let go from here.
      if (!store || store.get(key)?.endedAt == null) {
        return { removed: false }
      }
      return { removed: store.remove(key) }
    }
  }),
  defineMethod({
    name: SESSION_DECISIONS_RPC.answerWaits,
    params: SessionAnswerWaitsParamsSchema,
    // Why the person only: it feeds the warning before their own delete; a failed read throws.
    handler: async ({ sessions }, context): Promise<SessionAnswerWaitsResult> => {
      assertSessionOutcomeUser(context)
      const waitsFor = readAnswerWaits(context.runtime.getArtifactApiOrigin())
      return { waits: sessions.map((session) => waitsFor(session)) }
    }
  })
]
