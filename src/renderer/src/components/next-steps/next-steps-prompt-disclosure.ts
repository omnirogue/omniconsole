import type {
  NextStepSuggestion,
  NextStepSuggestionOrigin
} from '../../../../shared/next-step-suggestions'

/**
 * How a row shows the exact prompt a Run sends.
 * - `always`: an AI prompt is model output, so it is always on screen; "Run all safe" can never
 *   send one the person has not seen.
 * - `none`: an AI prompt that is just its title adds nothing to show.
 * - `open` / `closed`: a parsed prompt is the fixed template around its title, behind a
 *   disclosure that a risky step opens by default.
 */
export type NextStepPromptVisibility = 'always' | 'none' | 'open' | 'closed'

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function nextStepPromptVisibility(
  suggestion: Pick<NextStepSuggestion, 'title' | 'prompt' | 'risk'>,
  origin: NextStepSuggestionOrigin
): NextStepPromptVisibility {
  if (origin !== 'parsed') {
    return normalized(suggestion.prompt) === normalized(suggestion.title) ? 'none' : 'always'
  }
  return suggestion.risk === 'risky' ? 'open' : 'closed'
}
