/**
 * The `question` kind: an answer given on OmniOS to a session's Question card. While the card is
 * still open in a live pane the answer is typed into it, exactly as the Questions answer round
 * does; once the card has ended, the answer goes in as a prompt (the claimer's queue). A closed,
 * archived or deleted session is reopened first, like every other kind.
 */

import { formatSessionReference } from '../../shared/session-reference'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { applyOmniosAnswer, liveDecisionFor } from '../session-questions/omnios-question-apply'
import type {
  OmniosApplyOutcome,
  OmniosQuestionAnswer
} from '../session-questions/omnios-question-sync'
import { WorkDeliveryHold } from '../work-delivery/work-delivery-claimer-types'
import type {
  ClaimableDelivery,
  WorkDeliveryKindAdapter
} from '../work-delivery/work-delivery-kind'
import {
  beginCardTyping,
  cardTyped,
  cardTypingOutcome,
  cardTypingUncertain,
  endCardTyping
} from './answer-delivery-handover'
import { organizationFields, restoreForAnswer } from './answer-delivery-target'

type QuestionContext = {
  questionId?: unknown
  fingerprint?: unknown
  paneKey?: unknown
  sessionId?: unknown
  toolUseId?: unknown
  agent?: unknown
  title?: unknown
  answers?: unknown
  skipped?: unknown
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The answer as the Questions answer round would have typed it. */
export function questionAnswerOf(delivery: ClaimableDelivery): OmniosQuestionAnswer | null {
  const context = delivery.context as QuestionContext
  const id = context.questionId === undefined ? '' : String(context.questionId)
  const answers =
    context.answers && typeof context.answers === 'object' && !Array.isArray(context.answers)
      ? Object.fromEntries(
          Object.entries(context.answers as Record<string, unknown>).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string'
          )
        )
      : {}
  if (!id || !text(context.fingerprint)) {
    return null
  }
  return {
    id,
    fingerprint: text(context.fingerprint),
    paneKey: text(context.paneKey),
    sessionId: text(context.sessionId),
    toolUseId: text(context.toolUseId),
    answers,
    skipped: context.skipped === true
  }
}

/** Refusals that typed nothing because the card is no longer open: the queue takes it instead. */
const CARD_ENDED = [
  'The session is no longer waiting on this question',
  'The terminal that asked this question is gone'
]

export type QuestionLiveDeps = {
  isPending(fingerprint: string): boolean
  apply(answer: OmniosQuestionAnswer): Promise<OmniosApplyOutcome>
}

/** `deliverLive` for a question: the open card, at most once per answer on this computer. */
export async function deliverQuestionLive(
  deps: QuestionLiveDeps,
  delivery: ClaimableDelivery
): Promise<'typed' | 'not_open'> {
  const answer = questionAnswerOf(delivery)
  if (!answer) {
    return 'not_open'
  }
  if (cardTyped(delivery.key)) {
    return 'typed'
  }
  if (cardTypingUncertain(delivery.key)) {
    throw new Error(
      'Whether its card took the answer cannot be confirmed, so it is not sent again.'
    )
  }
  if (!deps.isPending(answer.fingerprint)) {
    return 'not_open'
  }
  if (!beginCardTyping(delivery.key)) {
    throw new WorkDeliveryHold('busy', 'Its card on this computer is being answered right now.')
  }
  let outcome: OmniosApplyOutcome
  try {
    outcome = await deps.apply(answer)
  } catch (error) {
    endCardTyping(delivery.key, 'uncertain')
    throw error
  }
  const typed = cardTypingOutcome(outcome)
  endCardTyping(delivery.key, typed)
  if (outcome.delivered) {
    return 'typed'
  }
  if (typed === 'uncertain') {
    throw new Error(outcome.error)
  }
  if (CARD_ENDED.some((start) => outcome.error.startsWith(start))) {
    return 'not_open'
  }
  throw new WorkDeliveryHold('error', outcome.error)
}

export function questionDeliveryAdapter(userDataPath: string): WorkDeliveryKindAdapter {
  return {
    kind: 'question',
    resolve: async (delivery, runtime) => {
      const context = delivery.context as QuestionContext
      const owner = delivery.owner
      const agent = owner?.provider || text(context.agent)
      const sessionId = owner?.conversationId || text(context.sessionId)
      if ((agent !== 'claude' && agent !== 'codex') || !sessionId) {
        return null
      }
      const paneKey = owner?.paneKey || text(context.paneKey)
      return {
        ref: formatSessionReference({ agent, sessionId, hostId: 'local' }),
        ...(paneKey ? { paneKey } : {}),
        ...(owner?.accountId ? { accountId: owner.accountId } : {}),
        ...(owner?.model ? { model: owner.model } : {}),
        ...(owner?.effort ? { effort: owner.effort } : {}),
        ...(owner?.folder ? { folder: owner.folder } : {}),
        ...(await organizationFields(runtime, sessionId)),
        transcript: 'present'
      }
    },
    text: (delivery) => delivery.text,
    respawnBrief: (delivery) =>
      `The session that asked this question can no longer be reopened (its transcript is gone), so you are its replacement: work in this folder, with this model and effort.\n\n${delivery.text}`,
    restoreDeleted: restoreForAnswer(userDataPath),
    deliverLive: (delivery, _target, runtime: OrcaRuntimeService) =>
      deliverQuestionLive(
        {
          isPending: (fingerprint) => liveDecisionFor(fingerprint) !== undefined,
          apply: (answer) => applyOmniosAnswer(runtime, answer)
        },
        delivery
      )
  }
}
