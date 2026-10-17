import { offeredListCandidates } from './next-step-offered-list'

const DIRECT_QUESTION =
  /^(?:should I|shall I|would you like me to|do you want me to|want me to)\s+[^?]+\?$/i

/** Only an explicit closing request for an answer, never a recommendation or optional offer. */
export function nextStepReplyDecision(text: string): string | null {
  const closing = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '\n[code block]\n')
    .slice(-24_000)
    .trimEnd()
    .split(/\n\s*\n/)
    .at(-1)
  if (
    !closing ||
    closing.split('\n').some((line) => /^(?: {4}|\t)|^\s*(?:>|\||#{1,6}\s)/.test(line))
  ) {
    return null
  }
  const last = closing
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .at(-1)
  if (!last || last.length > 600) {
    return null
  }
  if (DIRECT_QUESTION.test(last)) {
    return last
  }
  if (
    /^(?:please\s+)?(?:reply|choose|pick|tell me which|let me know which)\b/i.test(last) &&
    offeredListCandidates(text).length > 1
  ) {
    return last
  }
  return null
}
