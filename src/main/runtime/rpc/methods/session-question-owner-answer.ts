import {
  SESSION_QUESTION_OWNER_ANSWER_CAPABILITY,
  SESSION_QUESTION_OWNER_RPC,
  SessionQuestionOwnerReadParamsSchema,
  SessionQuestionOwnerAnswerParamsSchema,
  type SessionQuestionOwnerReadParams,
  type SessionQuestionOwnerAnswerResult,
  type SessionQuestionOwnerReadResult,
  type SessionQuestionOwnerRefusal
} from '../../../../shared/session-question-owner-answer'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { sessionHostActor } from '../../../session-host-owner/session-host-actor'
import { remoteControlsOn } from '../../../session-host-owner/session-host-switches'
import { PersistentSessionAnswerQuarantine } from '../../../session-manage/session-answer-quarantine'
import { answerSession, withSessionAnswerLock } from '../../../session-manage/session-manage-answer'
import {
  SessionManagePartialError,
  SessionManageRefusal
} from '../../../session-manage/session-manage-refusal'
import { defineMethod, type RpcContext } from '../core'
import { settleSessionAction, withPartialAudit } from './session-manage-support'
import { readOwnerQuestion } from './session-question-owner-reading'

function refusal(
  params: SessionQuestionOwnerReadParams,
  code: SessionQuestionOwnerRefusal['code'],
  message: string
): SessionQuestionOwnerRefusal {
  return { status: 'refused', runtimeId: params.runtimeId, target: params.target, code, message }
}

function caller(context: RpcContext, params: SessionQuestionOwnerReadParams) {
  if (
    !context.pairedDeviceId ||
    context.clientKind !== 'runtime' ||
    context.orchestrationCapability ||
    context.unattendedCaller ||
    context.orchestrationCompatibilityEvidence
  ) {
    return refusal(
      params,
      'provenance-required',
      'Only an authenticated paired OmniConsole UI can answer here. Nothing was sent.'
    )
  }
  if (
    !remoteControlsOn() ||
    !context.clientCapabilities?.includes(SESSION_QUESTION_OWNER_ANSWER_CAPABILITY)
  ) {
    return refusal(
      params,
      'unsupported-capability',
      'This paired connection does not support question answers, or remote controls are disabled. Nothing was sent.'
    )
  }
  if (context.runtime.getRuntimeId() !== params.runtimeId) {
    return refusal(
      params,
      'stale-question',
      'The execution runtime changed. Nothing was sent; refresh the question.'
    )
  }
  return sessionHostActor({
    kind: 'remote',
    transport: 'paired-runtime',
    peer: `paired:${context.pairedDeviceId}`,
    origin: { computer: 'paired computer', requester: { kind: 'person', via: 'Needs you' } }
  })
}

function readRefusal(params: SessionQuestionOwnerReadParams, error: unknown) {
  return refusal(
    params,
    error instanceof SessionManageRefusal ? 'stale-question' : 'not-eligible',
    error instanceof SessionManageRefusal
      ? error.message
      : 'The execution host could not verify this question. Nothing was sent; open its conversation.'
  )
}

export const SESSION_QUESTION_OWNER_METHODS = [
  defineMethod({
    name: SESSION_QUESTION_OWNER_RPC.read,
    params: SessionQuestionOwnerReadParamsSchema,
    handler: async (params, context): Promise<SessionQuestionOwnerReadResult> => {
      const actor = caller(context, params)
      if ('status' in actor) {
        return actor
      }
      try {
        return (await readOwnerQuestion(context, params, actor)).ready
      } catch (error) {
        return readRefusal(params, error)
      }
    }
  }),
  defineMethod({
    name: SESSION_QUESTION_OWNER_RPC.answer,
    params: SessionQuestionOwnerAnswerParamsSchema,
    handler: async (params, context): Promise<SessionQuestionOwnerAnswerResult> => {
      const actor = caller(context, params)
      if ('status' in actor) {
        return actor
      }
      let attempted = false
      try {
        const { prepared, deps } = await readOwnerQuestion(context, params, actor, params.binding)
        const result = await withSessionAnswerLock(
          `${prepared.row.worktreeId}:${prepared.entry.paneKey}`,
          async (lock) => {
            const answered = await withPartialAudit(context, prepared, 'answer', {}, () => {
              attempted = true
              return answerSession(deps, {
                actor,
                expect: params.binding.fingerprint,
                answer: params.answer,
                dryRun: false,
                lock
              })
            })
            return settleSessionAction(
              context,
              prepared,
              'answer',
              answered,
              {},
              {
                before: {
                  ask: answered.ask,
                  commandText: answered.commandText,
                  keepGoing: prepared.entry.keepGoing
                },
                after: {
                  chosen: answered.chosen,
                  delivery: answered.delivery,
                  keepGoing: answered.keepGoingStopped ? false : prepared.entry.keepGoing
                }
              }
            )
          },
          new PersistentSessionAnswerQuarantine(getProfileUserDataPath())
        )
        return {
          status: 'answered',
          runtimeId: params.runtimeId,
          target: params.target,
          binding: params.binding,
          delivery: result.delivery === 'dry-run' ? 'unconfirmed' : result.delivery,
          summary: result.summary
        }
      } catch (error) {
        if (error instanceof SessionManagePartialError) {
          return {
            status: 'answered',
            runtimeId: params.runtimeId,
            target: params.target,
            binding: params.binding,
            delivery: 'unconfirmed',
            summary: error.message
          }
        }
        if (attempted && !(error instanceof SessionManageRefusal)) {
          return {
            status: 'answered',
            runtimeId: params.runtimeId,
            target: params.target,
            binding: params.binding,
            delivery: 'unconfirmed',
            summary:
              'The execution host could not confirm the answer outcome. Inspect the conversation before answering again.'
          }
        }
        return readRefusal(params, error)
      }
    }
  })
]
