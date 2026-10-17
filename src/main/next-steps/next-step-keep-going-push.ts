/**
 * One "Push for better" round: the person's push prompt, sent on the turn Keep going last
 * accounted for, through the same marker, provenance, guard and stops as a next-step round. It
 * needs no AI set, and the hard-stop list does not apply to a prompt the person wrote.
 */

import {
  NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT,
  type NextStepKeepGoingState
} from '../../shared/next-step-keep-going'
import type { KeepGoingCore, StopReason } from './next-step-keep-going-core'
import { STOPPED_ENTRY_REASON, withdrawQueuedEntry } from './next-step-keep-going-queue'
import { keepGoingMarker, type RoundTrack } from './next-step-keep-going-rounds'
import { NEXT_STEP_TURN_ANSWERED_REASON, nextStepTurnHasAnswer } from './next-step-turn-answers'

/** Queue-entry id for one push round; the queue ignores a repeat. */
export function keepGoingPushEntryId(runToken: string, round: number): string {
  return `keep-going-push:${runToken}:${round}`
}

function pushRefusal(
  core: KeepGoingCore,
  key: string,
  state: NextStepKeepGoingState,
  turnKey: string
): [StopReason, string?] | null {
  if (!core.deps.isConversationOpen(state.conversation)) {
    return ['pane-closed']
  }
  if (core.currentTurnKey(key) !== turnKey) {
    return ['round-refused', 'A newer turn finished before this round was sent.']
  }
  if (nextStepTurnHasAnswer(core.deps.service, { conversation: state.conversation, turnKey })) {
    return ['round-refused', NEXT_STEP_TURN_ANSWERED_REASON]
  }
  if (state.roundsUsed >= state.maxRounds) {
    return ['cap-reached']
  }
  const guard = core.guard(state.conversation, undefined)
  return guard ? [guard] : null
}

/**
 * Pushes on `turnKey` once. Every check is read in the same tick as the enqueue, which is
 * synchronous, and the round counts once the queue has taken it.
 */
export function runPushRound(
  core: KeepGoingCore,
  key: string,
  state: NextStepKeepGoingState,
  track: RoundTrack,
  turnKey: string
): void {
  if (track.ranTurnKeys.has(turnKey)) {
    return
  }
  track.ranTurnKeys.add(turnKey)
  const refusal = pushRefusal(core, key, state, turnKey)
  if (refusal) {
    core.stop(key, refusal[0], refusal[1])
    return
  }
  const round = state.roundsUsed + 1
  const marker = keepGoingMarker(round, state.maxRounds, core.newToken())
  const entryId = keepGoingPushEntryId(track.runToken, round)
  const sentText = `${marker}${state.pushPrompt ?? NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT}`
  track.outstanding = { marker, entryId, round, turnKey, sentText, counted: false }
  try {
    core.deps.service.deps.enqueue(state.conversation, {
      id: entryId,
      text: sentText,
      origin: { kind: 'keep-going', runToken: track.runToken, round }
    })
  } catch (error) {
    track.outstanding = undefined
    core.stop(key, 'not-queued', error instanceof Error ? error.message : String(error))
    return
  }
  // Anything the enqueue itself set off (a stop, a newer turn) wins over counting the round.
  const latest = core.deps.store.get(key)
  if (core.tracks.get(key) !== track || !latest?.enabled) {
    withdrawQueuedEntry(core.queue, state.conversation, entryId, STOPPED_ENTRY_REASON)
    return
  }
  const after =
    core.currentTurnKey(key) !== turnKey
      ? 'person-message'
      : core.guard(state.conversation, entryId)
  if (after) {
    core.stop(key, after)
    return
  }
  core.countRound(key, track)
}
