/**
 * The session's own open next steps: what `session list` numbers as `pendingSteps` and what
 * `session continue --yes | --choose <n>` sends. Only the reply's own proposal (the parsed set of
 * the current turn) counts, never the AI suggester's ideas; when the reply offered one or more
 * options ("Should I …?"), those are the choices, exactly as the one-click Yes shows them.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { NextStepsCurrentResult } from '../../shared/next-step-suggestions-rpc'

export type SessionOwnSteps = { set: NextStepSuggestionSet | null; steps: NextStepSuggestion[] }

export const NO_OWN_STEPS: SessionOwnSteps = { set: null, steps: [] }

export function sessionOwnSteps(current: Pick<NextStepsCurrentResult, 'parsed'>): SessionOwnSteps {
  const set = current.parsed
  if (!set || set.status !== 'pending' || !set.conversation) {
    return NO_OWN_STEPS
  }
  const runnable = set.suggestions.filter((step) => step.prompt.trim())
  const offered = runnable.filter((step) => step.offered)
  return { set, steps: offered.length ? offered : runnable }
}

export async function readSessionOwnSteps(
  readCurrent: ((source: ConversationSource) => Promise<NextStepsCurrentResult>) | null,
  source: ConversationSource | null
): Promise<SessionOwnSteps> {
  if (!readCurrent || !source) {
    return NO_OWN_STEPS
  }
  try {
    return sessionOwnSteps(await readCurrent(source))
  } catch {
    return NO_OWN_STEPS
  }
}

/** The step `--yes` or `--choose <n>` names, or the refusal in plain words. */
export function chooseOwnStep(
  own: SessionOwnSteps,
  answer: { kind: 'yes' } | { kind: 'choose'; choice: number }
): { set: NextStepSuggestionSet; step: NextStepSuggestion } | { refusal: string } {
  const { set, steps } = own
  if (!set || steps.length === 0) {
    return { refusal: 'It has no open proposal of its own to answer, so nothing was sent.' }
  }
  const numbered = steps.map((step, index) => `${index + 1}. ${step.title}`).join('; ')
  if (answer.kind === 'yes') {
    return steps.length === 1
      ? { set, step: steps[0]! }
      : {
          refusal: `It offered ${steps.length} options, so --yes is ambiguous; pass --choose <n>: ${numbered}. Nothing was sent.`
        }
  }
  const step = steps[answer.choice - 1]
  return step
    ? { set, step }
    : {
        refusal: `It has ${steps.length} open step${steps.length === 1 ? '' : 's'} (${numbered}); there is no number ${answer.choice}. Nothing was sent.`
      }
}
