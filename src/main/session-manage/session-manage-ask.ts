/**
 * The send half of `omni session ask`: the question goes through the same checks, queue and agent
 * binding as `continue`, behind a marker that carries a request id of its own, so the answering
 * turn is tied to this one question (`session-manage-ask-wait.ts`).
 */

import type { ConversationSource } from '../../shared/conversation-source'
import {
  sessionManageActorTitle,
  sessionManageQuestionId,
  sessionManageQuestionMarker,
  type SessionManageActionResult,
  type SessionManageActor
} from '../../shared/session-manage-types'
import { sessionManageActorId } from './session-manage-caller'
import {
  assertDeliverable,
  queuedWords,
  refuseAdmission,
  relayPrompt,
  type SessionDeliveryDeps,
  type SessionDeliveryTarget
} from './session-manage-deliver'
import { FREEFORM_NOT_AN_APPROVAL, freeformApprovalRefusal } from './session-manage-freeform'
import { refuseQuestionHardStop, SessionManageRefusal } from './session-manage-refusal'
import { assertUnattendedPolicy } from './session-manage-unattended'
import { withUnattendedPrompt } from './session-manage-unattended-admission'
import { questionConversationGuard, requireKeepGoingOff } from './session-manage-ask-guard'

export async function queueQuestion(
  deps: SessionDeliveryDeps,
  input: {
    actor: SessionManageActor
    target: SessionDeliveryTarget
    question: string
    dryRun: boolean
    requireKeepGoingOff?: boolean
  }
): Promise<{
  result: SessionManageActionResult
  entryId?: string
  marker: string
  source: ConversationSource
}> {
  const { actor, target, question, dryRun } = input
  const deliverable = assertDeliverable(actor, target, 'ask')
  const { source } = deliverable
  assertUnattendedPolicy(actor, 'ask', target.entry)
  refuseQuestionHardStop(question, target.entry)
  const approval = freeformApprovalRefusal(question)
  if (approval) {
    throw new SessionManageRefusal(approval)
  }
  const actorTitle = sessionManageActorTitle(actor)
  const id = deps.newId()
  const marker = sessionManageQuestionMarker(actorTitle, sessionManageQuestionId(id))
  const sent = `${marker}${FREEFORM_NOT_AN_APPROVAL}\n${question}`
  refuseAdmission(deps, source, sent)
  const binding = questionConversationGuard(deps, target, input.requireKeepGoingOff === true)
  const title = target.entry.title
  const base = {
    dryRun,
    action: 'ask' as const,
    target: { paneKey: target.entry.paneKey, title },
    actor,
    sent
  }
  if (dryRun) {
    return {
      marker,
      source,
      result: {
        ...base,
        keepGoingStopped: !input.requireKeepGoingOff && target.entry.keepGoing,
        summary: `Would ask “${title}” a question from ${actorTitle}${!input.requireKeepGoingOff && target.entry.keepGoing ? ', turning its Keep going off first' : ''} ${queuedWords(target.entry, true)}.`
      }
    }
  }
  const entryId = `session-ask:${id}`
  const request = { kind: 'ask' as const, entry: target.entry, source, text: sent }
  const stopped = await withUnattendedPrompt(deps, actor, request, (delivery) => {
    if (!binding.conversationStill()) {
      throw new SessionManageRefusal(
        'The recipient conversation or Keep going setting changed before queueing. Nothing was sent.'
      )
    }
    return relayPrompt(
      input.requireKeepGoingOff ? requireKeepGoingOff(delivery) : delivery,
      deliverable,
      entryId,
      `${actorTitle} asked this conversation a question at your request.`,
      async () => {
        deps.enqueue(source, {
          id: entryId,
          text: sent,
          requestedBy: { action: 'ask', actor: sessionManageActorId(actor) }
        })
      },
      binding
    )
  })
  return {
    marker,
    source,
    entryId,
    result: {
      ...base,
      keepGoingStopped: stopped,
      summary: `Asked “${title}” a question from ${actorTitle}${stopped ? ' (its Keep going is off now)' : ''}. ${queuedWords(target.entry, false)}`
    }
  }
}
