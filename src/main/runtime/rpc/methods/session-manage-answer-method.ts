import { SESSION_MANAGE_RPC } from '../../../../shared/session-manage-types'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { PersistentSessionAnswerQuarantine } from '../../../session-manage/session-answer-quarantine'
import { answerSession, withSessionAnswerLock } from '../../../session-manage/session-manage-answer'
import { SessionManageRefusal } from '../../../session-manage/session-manage-deliver'
import { defineMethod } from '../core'
import { runtimeSessionAnswerDeps } from './session-manage-answer-runtime'
import { SessionManagePromptAnswerParams } from './session-manage-schemas'
import { remoteSessionAnswer } from './session-manage-remote'
import {
  prepareSessionAction,
  settleSessionAction,
  withPartialAudit
} from './session-manage-support'

export const SESSION_MANAGE_ANSWER_METHOD = defineMethod({
  name: SESSION_MANAGE_RPC.answer,
  params: SessionManagePromptAnswerParams,
  handler: async (params, context) => {
    // The exact pane named (never a sibling of its tab): the core's `findSessionManageRow`.
    const prepared = await prepareSessionAction(context, params.target)
    if (params.target.terminal && prepared.entry.terminal !== params.target.terminal) {
      throw new SessionManageRefusal(
        'The terminal handle changed. Nothing was sent; list the sessions again.'
      )
    }
    const remote = await remoteSessionAnswer(
      context,
      prepared,
      { action: 'answer', payload: { expect: params.expect, answer: params.answer } },
      params
    )
    if (remote) {
      return remote
    }
    return withSessionAnswerLock(
      `${prepared.row.worktreeId}:${prepared.entry.paneKey}`,
      async (lock) => {
        // A failure after Keep going was turned off, or after a keystroke may have landed, is
        // audited as partly applied.
        const result = await withPartialAudit(context, prepared, 'answer', params, () =>
          answerSession(runtimeSessionAnswerDeps(context, prepared), {
            actor: prepared.actor,
            expect: params.expect,
            answer: params.answer,
            dryRun: params.dryRun === true,
            lock
          })
        )
        // A dry run changed nothing; an answer turned Keep going off only when it says it did.
        const keepGoingAfter =
          !result.dryRun && result.keepGoingStopped === true ? false : prepared.entry.keepGoing
        return settleSessionAction(context, prepared, 'answer', result, params, {
          before: {
            ask: result.ask,
            commandText: result.commandText,
            keepGoing: prepared.entry.keepGoing
          },
          after: { chosen: result.chosen, delivery: result.delivery, keepGoing: keepGoingAfter }
        })
      },
      new PersistentSessionAnswerQuarantine(getProfileUserDataPath())
    )
  }
})
