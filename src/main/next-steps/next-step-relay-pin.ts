/**
 * A relayed `--yes`/`--choose` (`omni session continue`) names the exact step it checked. Decide
 * sends it only while the set still holds that step word for word and those words pass the hard
 * stops, checked after decide's last await, with only the claim between it and the enqueue.
 */

import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { adPausesFor } from './next-step-ad-pause-policy'
import { hardStopOf } from './next-step-keep-going-hard-stops'

export type NextStepRelayPin = { suggestionId: string; content: string }

/** A step's exact words: what the hard stops read and what a pin compares. */
export function nextStepContent(
  step: Pick<NextStepSuggestion, 'title' | 'prompt' | 'why'>
): string {
  return `${step.title}\n${step.prompt}\n${step.why ?? ''}`
}

/** Why the pinned step may not run from this set now, or null when it may. */
export function relayPinRefusal(
  set: NextStepSuggestionSet,
  suggestionIds: readonly string[],
  pin: NextStepRelayPin
): string | null {
  const step = set.suggestions.find((candidate) => candidate.id === pin.suggestionId)
  if (!step || suggestionIds.length !== 1 || suggestionIds[0] !== pin.suggestionId) {
    return 'The step it was checked against is no longer in its proposal, so nothing was sent.'
  }
  if (nextStepContent(step) !== pin.content) {
    return 'Its proposal changed after it was checked, so nothing was sent. Read it again and choose again.'
  }
  const stop = hardStopOf(pin.content, adPausesFor(set.conversation))
  return stop
    ? `Refused (hard stop: ${stop.category}): that step needs the person. Nothing was sent.`
    : null
}
