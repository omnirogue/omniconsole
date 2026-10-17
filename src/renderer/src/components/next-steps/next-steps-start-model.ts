import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'

export type NextStepsStartView = {
  shown: NextStepSuggestion[]
  /** The suggester is still writing; carry-over rows show but cannot be answered yet. */
  thinking: boolean
  failure: string | null
}

const NOTHING: NextStepsStartView = { shown: [], thinking: false, failure: null }

/** What a start set offers now. Answered, dismissed or retired sets offer nothing for the hour. */
export function nextStepsStartView(set: NextStepSuggestionSet | null): NextStepsStartView {
  if (!set) {
    return NOTHING
  }
  if (set.status === 'generating') {
    return { shown: set.suggestions, thinking: true, failure: null }
  }
  if (set.status === 'pending') {
    return { shown: set.suggestions, thinking: false, failure: set.error ?? null }
  }
  if (set.status === 'failed') {
    return { shown: [], thinking: false, failure: set.error ?? '' }
  }
  return NOTHING
}

/**
 * A terminal agent that has started but never taken a prompt: its only report is the session
 * boundary (Claude's SessionStart), with no prompt and no working state behind it.
 */
export function isFreshAgentStatus(
  entry: Pick<AgentStatusEntry, 'state' | 'sessionBoundary' | 'prompt' | 'stateHistory'> | undefined
): boolean {
  return Boolean(
    entry &&
    entry.state === 'done' &&
    entry.sessionBoundary &&
    !entry.prompt.trim() &&
    !entry.stateHistory.some((past) => past.state === 'working')
  )
}
