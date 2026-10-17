/**
 * One Keep going round, from the current turn's lead set to a counted delivery: which set, every
 * check re-read in the same tick as the enqueue, committing or withdrawing the round, and the
 * finished turn that proves it was ours.
 */

import { resolveAdPauses } from '../../shared/next-step-ad-pauses'
import type { NextStepKeepGoingState } from '../../shared/next-step-keep-going'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { nextStepPromptQueueEntryId, type decideNextSteps } from './next-step-decisions'
import type { KeepGoingCore, StopReason } from './next-step-keep-going-core'
import { firstStepRefusal, pausesAds } from './next-step-keep-going-hard-stops'
import { nextStepContent } from './next-step-relay-pin'
import { hasJudges, judgeFinishedRound, rememberReply } from './next-step-keep-going-judge'
import { runPushRound } from './next-step-keep-going-push'
import { STOPPED_ENTRY_REASON, withdrawQueuedEntry } from './next-step-keep-going-queue'
import {
  keepGoingMarker,
  turnIsRound,
  type KeepGoingRound,
  type RoundTrack
} from './next-step-keep-going-rounds'
import { NEXT_STEP_TURN_ANSWERED_REASON, nextStepTurnHasAnswer } from './next-step-turn-answers'

export function finishRoundTurn(
  core: KeepGoingCore,
  key: string,
  track: RoundTrack,
  turnKey: string,
  turn: { lastUserPrompt?: string; completedAt?: number; lastAssistantMessage?: string }
): void {
  const out = track.outstanding
  const conversation = core.deps.store.get(key)!.conversation
  const entry = out ? core.queue.readQueueEntry(conversation, out.entryId) : undefined
  if (!out || !turnIsRound(out, entry, turn)) {
    core.stop(key, 'person-message')
    return
  }
  core.countRound(key, track)
  track.outstanding = undefined
  track.seenTurnKey = turnKey
  const state = core.deps.store.get(key)!
  const refusal =
    state.roundsUsed >= state.maxRounds ? 'cap-reached' : core.guard(conversation, undefined)
  if (refusal) {
    core.stop(key, refusal)
    return
  }
  rememberReply(track, turn.lastAssistantMessage)
  // After the host has made this turn current (it observes it after Keep going reads it).
  const resume = () => queueMicrotask(() => evaluateRound(core, key))
  if (hasJudges(core.deps)) {
    void judgeFinishedRound(core, key, track, turnKey, resume)
  } else if (state.mode === 'push-for-better') {
    resume()
  }
}

/** Only the current turn's lead set is ever looked at: the reply's own steps, else the AI's. */
export function evaluateRound(core: KeepGoingCore, key: string): void {
  const state = core.deps.store.get(key)
  const track = core.tracks.get(key)
  if (!state?.enabled || !track || track.running || track.outstanding || track.judging) {
    return
  }
  const turnKey = core.currentTurnKey(key)
  if (turnKey === null) {
    core.stop(key, 'turn-unknown')
    return
  }
  if (state.mode === 'push-for-better') {
    // Only a turn Keep going accounted for; any other is still on its way to `onTurnSignal`.
    if (turnKey === track.seenTurnKey) {
      runPushRound(core, key, state, track, turnKey)
    }
    return
  }
  const sets = core.roundSetsOf(key, turnKey)
  // An answered or retired set is no round; the next open (or failed) one in the lead order is.
  const set =
    sets.find((entry) => entry.status === 'pending' || entry.status === 'failed') ?? sets[0]
  if (!set || track.seenSetIds.has(set.id)) {
    return
  }
  if (set.status === 'failed') {
    track.seenSetIds.add(set.id)
    core.stop(key, 'set-failed', set.error)
  } else if (set.status === 'pending') {
    track.seenSetIds.add(set.id)
    void runRound(core, key, state, track, set)
  }
}

/**
 * Every check is re-read in the same tick as the enqueue (decide claims and queues before its
 * first await), so nothing can change between the last check and the queueing.
 */
function runRound(
  core: KeepGoingCore,
  key: string,
  state: NextStepKeepGoingState,
  track: RoundTrack,
  set: NextStepSuggestionSet
): Promise<void> | void {
  if (track.ranTurnKeys.has(set.turnKey)) {
    return
  }
  track.ranTurnKeys.add(set.turnKey)
  const refusal = roundRefusal(core, key, state, set)
  if (refusal) {
    core.stop(key, refusal[0], refusal[1])
    return
  }
  const first = set.suggestions[0]!
  const round = state.roundsUsed + 1
  const marker = keepGoingMarker(round, state.maxRounds, core.newToken())
  // Past the hard stops, so a pause here is one the person allowed.
  const adPause = pausesAds(nextStepContent(first))
  track.running = true
  track.outstanding = {
    marker,
    entryId: nextStepPromptQueueEntryId(set.id, first.id),
    round,
    turnKey: set.turnKey,
    sentText: `${marker}${first.prompt}`,
    counted: false,
    ...(adPause ? { adPause: first.title } : {})
  }
  const origin = { kind: 'keep-going' as const, runToken: track.runToken, round }
  const decision = {
    action: 'run' as const,
    suggestionIds: [first.id],
    auto: true,
    ...(adPause ? { adPause: true } : {})
  }
  let decided: ReturnType<typeof decideNextSteps>
  try {
    decided = core.decide(core.deps.service, set.id, decision, core.now(), {
      prefix: marker,
      origin,
      recheck: (current) => recheckRound(core, key, track, first, current)
    })
  } catch (error) {
    decided = Promise.reject(error)
  }
  return decided
    .then(
      (result) =>
        afterRound(core, key, track, {
          queued: result.queued.includes(first.id),
          reason: 'not-queued',
          detail: result.notQueued.map((entry) => entry.reason).join(' ')
        }),
      (error: unknown) =>
        afterRound(core, key, track, {
          queued: false,
          reason: 'round-refused',
          detail: error instanceof Error ? error.message : String(error)
        })
    )
    .finally(() => {
      track.running = false
    })
}

/**
 * Run by decide after its last await, in the same tick as the enqueue: every condition is read
 * again, and anything changed stops Keep going instead of sending.
 */
function recheckRound(
  core: KeepGoingCore,
  key: string,
  track: RoundTrack,
  first: NextStepSuggestionSet['suggestions'][number],
  current: NextStepSuggestionSet
): string | null {
  const latest = core.deps.store.get(key)
  if (core.tracks.get(key) !== track || !latest?.enabled) {
    return 'Keep going was turned off before this round was sent.'
  }
  const top = current.suggestions[0]
  const refusal: [StopReason, string?] | null = !core.deps.isConversationOpen(latest.conversation)
    ? ['pane-closed']
    : top?.id !== first.id || top.prompt !== first.prompt
      ? ['round-refused', 'The suggestion changed before it was sent.']
      : roundRefusal(core, key, latest, current, track.outstanding?.entryId)
  if (!refusal) {
    return null
  }
  core.stop(key, refusal[0], refusal[1])
  return `Keep going stopped before this was sent (${refusal[0]}).`
}

function roundRefusal(
  core: KeepGoingCore,
  key: string,
  state: NextStepKeepGoingState,
  set: NextStepSuggestionSet,
  startingEntryId?: string
): [StopReason, string?] | null {
  if (core.currentTurnKey(key) !== set.turnKey) {
    return ['round-refused', 'These suggestions are for an earlier turn.']
  }
  const turn = { conversation: state.conversation, turnKey: set.turnKey }
  if (nextStepTurnHasAnswer(core.deps.service, turn)) {
    return ['round-refused', NEXT_STEP_TURN_ANSWERED_REASON]
  }
  // A round still out reserves its place under the cap until it is counted.
  const out = core.tracks.get(key)?.outstanding
  const reserved = out && !out.counted && out.entryId !== startingEntryId ? 1 : 0
  if (state.roundsUsed + reserved >= state.maxRounds) {
    return ['cap-reached']
  }
  const guard = core.guard(state.conversation, undefined)
  if (guard) {
    return [guard]
  }
  const step = firstStepRefusal(set, keepGoingAdPauses(core, state))
  return step ? [step.reason, step.detail] : null
}

/** This conversation's own ad-pause choice wins over the global one. */
function keepGoingAdPauses(core: KeepGoingCore, state: NextStepKeepGoingState) {
  return resolveAdPauses(core.deps.service.deps.settings().adPauses, state.adPauses)
}

/** An allowed ad pause went out: kept on the state, so the tray and `omni session` can show it. */
function recordAdPause(core: KeepGoingCore, key: string, out: KeepGoingRound): void {
  const state = core.deps.store.get(key)
  if (out.adPause === undefined || !state) {
    return
  }
  const title = out.adPause.slice(0, 500)
  core.deps.store.set({ ...state, lastAdPause: { at: core.now(), round: out.round, title } })
  console.info(`[next-steps] keep going round ${out.round} paused ads without asking: ${title}`)
}

/** Commits the round only if, re-read now, it is still wanted; otherwise withdraws it. */
function afterRound(
  core: KeepGoingCore,
  key: string,
  track: RoundTrack,
  outcome: { queued: boolean; reason: StopReason; detail: string }
): void {
  const state = core.deps.store.get(key)
  const out = track.outstanding
  if (core.tracks.get(key) !== track || !state?.enabled || !out) {
    if (state && out) {
      withdrawQueuedEntry(core.queue, state.conversation, out.entryId, STOPPED_ENTRY_REASON)
    }
    return
  }
  if (!outcome.queued) {
    track.outstanding = undefined
    core.stop(key, outcome.reason, outcome.detail)
    return
  }
  const refusal =
    core.currentTurnKey(key) !== out.turnKey
      ? 'person-message'
      : core.guard(state.conversation, out.entryId)
  if (refusal) {
    core.stop(key, refusal)
    return
  }
  core.countRound(key, track)
  recordAdPause(core, key, out)
}
