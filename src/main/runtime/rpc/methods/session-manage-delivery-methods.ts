// `sessionManage.continue` / `sessionManage.ask`: the one sanctioned way another conversation's
// words reach a session (Sal, D3). Narrow by design: the target's own queue only (never raw
// terminal input), the Keep going hard stops on the exact text, a visible marker and provenance
// naming the actor, and Keep going off first. `promptQueue.enqueue` and `nextSteps.decide` keep
// their person-only gate.

import { conversationSourceRowKey } from '../../../../shared/conversation-source'
import {
  parseSessionReference,
  rowHoldsSessionReference
} from '../../../../shared/session-reference'
import { sessionManageHostKey } from '../../../../shared/session-manage-query'
import { SessionManageRefusal } from '../../../session-manage/session-manage-refusal'
import {
  SESSION_MANAGE_RPC,
  type SessionManageAskResult
} from '../../../../shared/session-manage-types'
import { waitForAskReply } from '../../../session-manage/session-manage-ask-wait'
import { queueQuestion } from '../../../session-manage/session-manage-ask'
import { continueSession } from '../../../session-manage/session-manage-continue'
import {
  runtimeAskWaitDeps,
  runtimeDeliveryDeps
} from '../../../session-manage/session-manage-runtime-actions'
import { defineMethod, type RpcMethod } from '../core'
import { remoteSessionAction, remoteSessionAsk } from './session-manage-remote'
import {
  SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS,
  SessionManageAskParams,
  SessionManageContinueParams
} from './session-manage-schemas'
import {
  prepareSessionAction,
  settleSessionAction,
  withPartialAudit
} from './session-manage-support'

/** The host takes 1 s to 30 min; the local wait's bounds are this computer's own. */
function remoteAskTimeout(timeoutMs: number): number {
  return Math.min(30 * 60_000, Math.max(1_000, timeoutMs))
}

export const SESSION_MANAGE_DELIVERY_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_MANAGE_RPC.continue,
    params: SessionManageContinueParams,
    handler: async (params, context) => {
      const prepared = await prepareSessionAction(context, params.target)
      const remote = await remoteSessionAction(
        context,
        prepared,
        { action: 'continue', payload: { answer: params.answer } },
        params
      )
      if (remote) {
        return remote
      }
      const { result, entryId } = await withPartialAudit(
        context,
        prepared,
        'continue',
        params,
        () =>
          continueSession(runtimeDeliveryDeps(context.runtime), {
            actor: prepared.actor,
            target: prepared,
            answer: params.answer,
            dryRun: params.dryRun === true
          })
      )
      return settleSessionAction(context, prepared, 'continue', result, params, {
        before: { state: prepared.entry.state, keepGoing: prepared.entry.keepGoing },
        after: { queued: result.sent, keepGoing: false },
        ...(entryId ? { undoEntryId: entryId, source: prepared.source } : {})
      })
    }
  }),
  defineMethod({
    name: SESSION_MANAGE_RPC.ask,
    params: SessionManageAskParams,
    handler: async (params, context): Promise<SessionManageAskResult> => {
      const prepared = await prepareSessionAction(context, params.target)
      if (params.expectedRef) {
        const expected = parseSessionReference(params.expectedRef)!
        if (
          prepared.entry.agent !== expected.agent ||
          !rowHoldsSessionReference(expected, prepared.entry)
        ) {
          throw new SessionManageRefusal(
            'The recipient no longer holds the requested conversation. Nothing was sent.'
          )
        }
      }
      if (params.requireKeepGoingOff && sessionManageHostKey(prepared.entry.hostId) !== 'local') {
        throw new SessionManageRefusal(
          'This host cannot enforce require-keep-going-off remotely. Run the command on the recipient computer. Nothing was sent.'
        )
      }
      const remote = await remoteSessionAsk(
        context,
        prepared,
        {
          action: 'ask',
          payload: {
            question: params.question,
            ...(params.timeoutMs ? { timeoutMs: remoteAskTimeout(params.timeoutMs) } : {})
          }
        },
        params
      )
      if (remote) {
        return remote
      }
      const queued = await withPartialAudit(context, prepared, 'ask', params, () =>
        queueQuestion(runtimeDeliveryDeps(context.runtime), {
          actor: prepared.actor,
          target: prepared,
          question: params.question,
          requireKeepGoingOff: params.requireKeepGoingOff,
          dryRun: params.dryRun === true
        })
      )
      // Listening starts before anything else awaits, so no answering turn can slip past.
      const waiting = queued.entryId
        ? waitForAskReply(runtimeAskWaitDeps(context.runtime, queued.source, queued.entryId), {
            rowKey: conversationSourceRowKey(queued.source),
            marker: queued.marker,
            sentText: queued.result.sent!,
            timeoutMs: params.timeoutMs ?? SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS,
            ...(context.signal ? { signal: context.signal } : {})
          })
        : null
      const settled = await settleSessionAction(context, prepared, 'ask', queued.result, params, {
        before: { state: prepared.entry.state, keepGoing: prepared.entry.keepGoing },
        after: { queued: queued.result.sent },
        ...(queued.entryId ? { undoEntryId: queued.entryId, source: queued.source } : {})
      })
      if (!waiting) {
        return settled
      }
      const outcome = await waiting
      const name = `“${prepared.entry.title}”`
      switch (outcome.outcome) {
        case 'answered':
          return {
            ...settled,
            outcome: 'answered',
            reply: outcome.reply,
            summary: `${name} answered.`
          }
        case 'failed':
          return {
            ...settled,
            outcome: 'failed',
            failure: outcome.reason,
            summary: `${name} did not answer: ${outcome.reason}`
          }
        case 'timeout':
          return {
            ...settled,
            outcome: 'timeout',
            question: outcome.question,
            ...(outcome.note ? { note: outcome.note } : {}),
            summary:
              outcome.question === 'withdrawn'
                ? `No answer in time: ${name} was still busy, so the question was withdrawn unsent.`
                : `No answer in time. ${name} already has the question; its answer will be in that conversation (omni terminal read, or open it).`
          }
      }
    }
  })
]
