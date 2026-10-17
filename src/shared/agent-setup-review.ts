import { stripAnsiEscapeSequences } from './ansi-escape-sequences'

/** Match the current review dialog, not an ordinary reference to hooks in work. */
export function hasOptionalAutomationReview(screen: string | null): boolean {
  const text = screen ? stripAnsiEscapeSequences(screen) : ''
  return (
    /\bHooks\b/i.test(text) &&
    /hooks?\s+needs?\s+review/i.test(text) &&
    /esc\s+to\s+(?:close|go back)/i.test(text)
  )
}
