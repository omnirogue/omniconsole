import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'

/** At most this many one-click options; a longer list stays in the tray. */
export const NEXT_STEPS_ANSWER_OPTIONS_MAX = 4

/**
 * The session asked the person something it can act on: one proposal ("Should I …?") is a single
 * "Yes"; several offered options are one button each; options the reply offered together as one
 * menu (`optionGroup`) are a checklist the person ticks and builds in one message. Null when the
 * reply only listed next steps.
 */
export type NextStepsAnswer =
  | { kind: 'yes'; set: NextStepSuggestionSet; step: NextStepSuggestion }
  | { kind: 'options'; set: NextStepSuggestionSet; steps: NextStepSuggestion[] }
  | {
      kind: 'choose'
      set: NextStepSuggestionSet
      steps: NextStepSuggestion[]
      /** Ticked in advance: the options the reply named, never a risky one. */
      preselectedIds: string[]
    }

/** One click per option: the kinds the answer bar shows as buttons. */
export type NextStepsButtonAnswer = Exclude<NextStepsAnswer, { kind: 'choose' }>

export function nextStepsAnswerOf(
  set: NextStepSuggestionSet | null | undefined
): NextStepsAnswer | null {
  if (!set || set.origin !== 'parsed' || set.status !== 'pending') {
    return null
  }
  const offered = set.suggestions.filter((step) => step.offered && step.prompt.trim())
  const group = offered[0]?.optionGroup
  // Why any count: the host sends the ticked options of one menu as ONE message.
  if (offered.length > 1 && group && offered.every((step) => step.optionGroup === group)) {
    return {
      kind: 'choose',
      set,
      steps: offered,
      // A risky row is never pre-ticked; the person can still tick it.
      preselectedIds: offered
        .filter((step) => step.preselected && step.risk === 'safe')
        .map((step) => step.id)
    }
  }
  if (offered.length === 1) {
    return { kind: 'yes', set, step: offered[0]! }
  }
  return offered.length > 1 && offered.length <= NEXT_STEPS_ANSWER_OPTIONS_MAX
    ? { kind: 'options', set, steps: offered }
    : null
}
