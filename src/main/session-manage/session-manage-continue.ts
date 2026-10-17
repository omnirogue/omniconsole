/**
 * `omni session continue`: `--yes`/`--choose` send the chosen step's own words through the same
 * decision path as the one-click Yes, pinned to the exact words that passed the hard stops; a free
 * `--prompt` goes only to a conversation that finished its turn with nothing open, and never
 * approves anything (`session-manage-freeform.ts`). Either way the prompt is bound to the
 * conversation it was checked against, re-checked by the guarded write before the text and Enter.
 */

import type { PromptQueueRequestedBy } from '../../shared/prompt-queue-types'
import {
  sessionManageActorTitle,
  sessionManagePromptMarker,
  type SessionManageActionResult,
  type SessionManageActor
} from '../../shared/session-manage-types'
import { adPausesFor } from '../next-steps/next-step-ad-pause-policy'
import { nextStepPromptQueueEntryId } from '../next-steps/next-step-decisions'
import { nextStepContent } from '../next-steps/next-step-relay-pin'
import { sessionManageActorId } from './session-manage-caller'
import {
  assertDeliverable,
  queuedWords,
  refuseAdmission,
  relayPrompt,
  type SessionDeliveryDeps,
  type SessionDeliveryTarget,
  type SessionManageAnswer
} from './session-manage-deliver'
import {
  conversationFence,
  conversationGuard,
  FREEFORM_NOT_AN_APPROVAL,
  freeformApprovalRefusal,
  freeformRefusal
} from './session-manage-freeform'
import { refuseHardStop, SessionManageRefusal } from './session-manage-refusal'
import { chooseOwnStep } from './session-manage-steps'
import { assertUnattendedPolicy } from './session-manage-unattended'
import { withUnattendedPrompt } from './session-manage-unattended-admission'

type ContinueResult = { result: SessionManageActionResult; entryId?: string }

export async function continueSession(
  deps: SessionDeliveryDeps,
  input: {
    actor: SessionManageActor
    target: SessionDeliveryTarget
    answer: SessionManageAnswer
    dryRun: boolean
    /** Host-generated transfer correlation; precedes the long safety note for bounded hooks. */
    transferId?: string
    /** Words right after the marker, before the safety note (`session assign`: "New task for you:"). */
    lead?: string
  }
): Promise<ContinueResult> {
  const { actor, target, answer, dryRun } = input
  const deliverable = assertDeliverable(actor, target, 'continue')
  const { source } = deliverable
  assertUnattendedPolicy(actor, answer.kind === 'prompt' ? 'prompt' : 'yes', target.entry)
  const actorTitle = sessionManageActorTitle(actor)
  if (
    input.transferId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.transferId)
  ) {
    throw new SessionManageRefusal('Invalid transfer correlation identity.')
  }
  const marker = `${input.transferId ? `[Brief b-${input.transferId}] ` : ''}${sessionManagePromptMarker(actorTitle)}`
  const requestedBy: PromptQueueRequestedBy = {
    action: 'continue',
    actor: sessionManageActorId(actor)
  }
  const title = target.entry.title
  const base = {
    dryRun,
    action: 'continue' as const,
    target: { paneKey: target.entry.paneKey, title },
    actor
  }
  const detail = `${actorTitle} continued this conversation at your request.`
  const keepGoingWords = target.entry.keepGoing ? ', turning its Keep going off first' : ''
  const readTurn = () => deps.readLatestTurn(source)
  // The fence both ways: re-read before delivery and each write, and in memory on every change.
  const fencedTo = (fence: string, withProposal: boolean) => ({
    conversationGuard: conversationGuard(fence, withProposal, readTurn),
    conversationStill: () =>
      conversationFence(deps.snapshotLatestTurn(source), withProposal) === fence
  })
  if (answer.kind === 'prompt') {
    refuseHardStop(answer.text, target.entry)
    const approval = freeformApprovalRefusal(answer.text)
    if (approval) {
      throw new SessionManageRefusal(approval)
    }
    const turn = await readTurn()
    const refusal = freeformRefusal({
      state: target.entry.state,
      turn,
      adPauses: adPausesFor(target.entry)
    })
    if (refusal) {
      throw new SessionManageRefusal(refusal)
    }
    const sent = `${marker}${input.lead ? `${input.lead} ` : ''}${FREEFORM_NOT_AN_APPROVAL}\n${answer.text}`
    refuseAdmission(deps, source, sent)
    if (dryRun) {
      return {
        result: {
          ...base,
          sent,
          keepGoingStopped: target.entry.keepGoing,
          summary: `Would queue a prompt for “${title}” from ${actorTitle}${keepGoingWords} ${queuedWords(target.entry, true)}.`
        }
      }
    }
    const entryId = `session-manage:${deps.newId()}`
    const request = { kind: 'prompt' as const, entry: target.entry, source, text: sent }
    const stopped = await withUnattendedPrompt(deps, actor, request, (delivery) =>
      relayPrompt(
        delivery,
        deliverable,
        entryId,
        detail,
        async () => deps.enqueue(source, { id: entryId, text: sent, requestedBy }),
        fencedTo(conversationFence(turn, true), true)
      )
    )
    return {
      entryId,
      result: {
        ...base,
        sent,
        keepGoingStopped: stopped,
        summary: `Queued a prompt for “${title}” from ${actorTitle}${stopped ? ' (its Keep going is off now)' : ''}. ${queuedWords(target.entry, false)}`
      }
    }
  }
  const [own, turn] = await Promise.all([deps.readOwnSteps(source), readTurn()])
  const chosen = chooseOwnStep(own, answer)
  if ('refusal' in chosen) {
    throw new SessionManageRefusal(chosen.refusal)
  }
  const { set, step } = chosen
  const content = nextStepContent(step)
  refuseHardStop(content, target.entry)
  if (!turn.known || turn.turnKey !== set.turnKey) {
    throw new SessionManageRefusal(
      'Its proposal is not on the latest turn this host can read, so nothing was sent. List it again and answer its current proposal.'
    )
  }
  const sent = `${marker}${step.prompt}`
  refuseAdmission(deps, source, sent)
  if (dryRun) {
    return {
      result: {
        ...base,
        sent,
        keepGoingStopped: target.entry.keepGoing,
        summary: `Would answer “${title}” yes to its own proposal “${step.title}” from ${actorTitle}${keepGoingWords} ${queuedWords(target.entry, true)}.`
      }
    }
  }
  // The person's own answer stops Keep going on the host before `decide`; so does this one.
  const entryId = nextStepPromptQueueEntryId(set.id, step.id)
  const request = { kind: 'yes' as const, entry: target.entry, source, text: sent }
  const stopped = await withUnattendedPrompt(deps, actor, request, (delivery) =>
    relayPrompt(
      delivery,
      deliverable,
      entryId,
      detail,
      async () => {
        const decided = await deps.decideRelayed(set.id, step.id, {
          prefix: marker,
          requestedBy,
          via: requestedBy.actor,
          pinned: { suggestionId: step.id, content }
        })
        if (!decided.queued.includes(step.id)) {
          const reason = decided.notQueued.find((entry) => entry.id === step.id)?.reason
          throw new SessionManageRefusal(
            `Its proposal could not be queued${reason ? `: ${reason}` : '.'}`
          )
        }
      },
      // Why not its proposal: this answer settles it; the turn and its reply must not change.
      fencedTo(conversationFence(turn, false), false)
    )
  )
  return {
    result: {
      ...base,
      sent,
      keepGoingStopped: stopped,
      summary: `Answered “${title}” yes to its own proposal “${step.title}”, from ${actorTitle}${stopped ? ' (its Keep going is off now)' : ''}. ${queuedWords(target.entry, false)}`
    }
  }
}
