import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { NextStepGenerateOutcome } from './next-step-generate-outcome'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import type { FinishedTurn } from './next-step-turn-signal'

export const NEXT_STEP_SESSION_PROPOSED_REASON = 'The reply proposed its own next steps.'

/**
 * One admitted suggester call, settled into its set. An explicit ask on a turn with the reply's
 * own steps is told them, and its result stands beside them; otherwise a result that lands after
 * the reply's own steps were read is retired.
 */
export async function runNextStepGeneration(
  service: NextStepSuggestionService,
  setId: string,
  turn: FinishedTurn,
  signal: AbortSignal,
  explicit: boolean
): Promise<void> {
  const { store } = service.deps
  const key = conversationSourceRowKey(turn.conversation)
  const proposed = service
    .findSet(key, turn.turnKey, 'parsed')
    ?.suggestions.map((step) => step.title)
  const outcome = await service.deps
    .generate(turn, signal, proposed?.length ? { proposedSteps: proposed } : undefined)
    .catch((error: unknown): NextStepGenerateOutcome => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
  const current = store.get(setId)
  if (current?.status !== 'generating') {
    return
  }
  if (signal.aborted || !outcome.ok) {
    store.upsert({
      ...current,
      status: 'failed',
      error: outcome.ok ? 'Suggestions were cancelled.' : outcome.error
    })
    return
  }
  const lateParsed = !explicit && service.findSet(key, turn.turnKey, 'parsed')
  store.upsert({
    ...current,
    status: lateParsed ? 'superseded' : 'pending',
    suggestions: outcome.suggestions,
    ...(outcome.model ? { model: outcome.model } : {}),
    ...outcome.judged,
    ...(lateParsed ? { error: NEXT_STEP_SESSION_PROPOSED_REASON } : {})
  })
}
