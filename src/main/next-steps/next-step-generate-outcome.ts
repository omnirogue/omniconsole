import type {
  NextStepGitFacts,
  NextStepGitFactsUnavailable
} from '../../shared/next-step-suggestion-prompt'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'

/** One suggester call's answer, as the service stores it. */
export type NextStepGenerateOutcome =
  | {
      ok: true
      suggestions: NextStepSuggestion[]
      model?: string
      /** The git facts the suggester was given, so JEV judges from the same turn text. */
      git?: NextStepGitFacts | NextStepGitFactsUnavailable
      /** JEV's marks on the set (`next-step-jev.ts`). */
      judged?: Pick<NextStepSuggestionSet, 'rankedBy' | 'jevScores'>
    }
  | { ok: false; error: string }
