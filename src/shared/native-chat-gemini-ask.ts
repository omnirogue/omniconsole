import type { AskAnswerKeyGroup, AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt, AskQuestion } from './native-chat-ask-types'
import { parseAskOptions } from './native-chat-ask-options'
import { optionOnlyAnswerIndices } from './native-chat-option-only-ask'

export const GEMINI_ASK_USER_TOOL = 'ask_user'

/** Gemini CLI `ask_user` input; null unless every question is a `choice` with options. */
export function parseGeminiAskUser(input: unknown): AskPrompt | null {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw) || raw.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return null
    }
    const question = entry as Record<string, unknown>
    // Why: text/yesno questions take typing in the TUI, which one click cannot do safely.
    if (question.type !== undefined && question.type !== 'choice') {
      return null
    }
    const options = parseAskOptions(question.options)
    if (typeof question.question !== 'string' || options.length === 0) {
      return null
    }
    questions.push({
      question: question.question,
      header: typeof question.header === 'string' ? question.header : undefined,
      multiSelect: question.multiSelect === true,
      options,
      ...(typeof question.placeholder === 'string' && question.placeholder.trim()
        ? { placeholder: question.placeholder }
        : {})
    })
  }
  return { questions }
}

/**
 * Gemini's ask_user dialog: a digit picks that option and advances (a lone question submits);
 * a batch ends on a Review tab where Enter submits. Multi-select is refused: its digits toggle,
 * its Done row wraps and fast arrows are dropped, so no keystroke plan is reliable.
 */
export function buildGeminiAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const answers = optionOnlyAnswerIndices(prompt, selections, { allowMultiSelect: false })
  if (!answers) {
    return []
  }
  const groups: AskAnswerKeyGroup[] = answers.map(([index], question) => ({
    raw: String(index! + 1),
    screen: question
  }))
  if (answers.length > 1) {
    groups.push({ raw: '\r', screen: 'submit' })
  }
  return groups
}
