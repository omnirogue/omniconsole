// Where the `nextSteps.*` methods find this host's suggester. A module slot, not a runtime field:
// the runtime service is past its size budget (same shape as the structured-session registry).

import type { NextStepKeepGoingController } from './next-step-keep-going'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import type { TurnSignal } from './next-step-turn-signal'

let service: NextStepSuggestionService | null = null

export function getNextStepSuggestionService(): NextStepSuggestionService | null {
  return service
}

export function setNextStepSuggestionService(next: NextStepSuggestionService | null): void {
  service = next
}

let keepGoing: NextStepKeepGoingController | null = null

export function getNextStepKeepGoingController(): NextStepKeepGoingController | null {
  return keepGoing
}

export function setNextStepKeepGoingController(next: NextStepKeepGoingController | null): void {
  keepGoing = next
}

const turnListeners = new Set<(signal: TurnSignal) => void>()

/** Every turn signal this host classifies, for a waiter such as `omni session ask`. */
export function onNextStepTurnSignal(listener: (signal: TurnSignal) => void): () => void {
  turnListeners.add(listener)
  return () => {
    turnListeners.delete(listener)
  }
}

export function emitNextStepTurnSignal(signal: TurnSignal): void {
  for (const listener of turnListeners) {
    try {
      listener(signal)
    } catch (error) {
      console.warn('[next-steps] a turn listener failed', error)
    }
  }
}
