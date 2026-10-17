import type { AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'

// Why 9: each option is one digit keystroke; "10" would commit option 1 first.
export const MAX_DIGIT_ADDRESSABLE_OPTIONS = 9

/**
 * The picked option indices per question when the whole prompt is answered by options alone,
 * else null. For selectors where a skipped question, free text or a stray key is unsafe.
 */
export function optionOnlyAnswerIndices(
  prompt: AskPrompt,
  selections: readonly AskAnswerSelection[],
  options: { allowMultiSelect: boolean }
): number[][] | null {
  const { questions } = prompt
  if (prompt.delivery === 'async' || questions.length === 0) {
    return null
  }
  if (selections.length !== questions.length) {
    return null
  }
  const answers: number[][] = []
  for (const [questionIndex, question] of questions.entries()) {
    const selection = selections[questionIndex]
    if (!selection || (selection.other ?? '').length > 0) {
      return null
    }
    if (question.multiSelect && !options.allowMultiSelect) {
      return null
    }
    const limit = Math.min(question.options.length, MAX_DIGIT_ADDRESSABLE_OPTIONS)
    const indices = [...new Set(selection.indices)].sort((a, b) => a - b)
    if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= limit)) {
      return null
    }
    if (question.multiSelect ? indices.length === 0 : indices.length !== 1) {
      return null
    }
    answers.push(indices)
  }
  return answers
}

/** Whether the card can ever produce an answer this selector accepts. */
export function isOptionOnlyAnswerable(
  prompt: AskPrompt,
  options: { allowMultiSelect: boolean }
): boolean {
  return (
    prompt.delivery !== 'async' &&
    prompt.questions.length > 0 &&
    prompt.questions.every(
      (question) =>
        question.options.length > 0 &&
        question.options.length <= MAX_DIGIT_ADDRESSABLE_OPTIONS &&
        (options.allowMultiSelect || !question.multiSelect)
    )
  )
}

// Why an envelope: clients from before option-only answering parse bare `questions` and paste
// labels into the selector; they find no questions under this key, so they show no card.
const OPTION_ONLY_ASK_KEY = 'optionOnlyAsk'

/** Status `interactivePrompt` for a question only option keystrokes may answer. */
export function serializeOptionOnlyAsk(toolInput: unknown): string | undefined {
  if (toolInput === undefined || toolInput === null) {
    return undefined
  }
  try {
    return JSON.stringify({ [OPTION_ONLY_ASK_KEY]: toolInput })
  } catch {
    return undefined
  }
}

/** The tool input inside an option-only envelope, else the input unchanged. */
export function unwrapOptionOnlyAsk(input: unknown): unknown {
  return input && typeof input === 'object' && OPTION_ONLY_ASK_KEY in input
    ? (input as Record<string, unknown>)[OPTION_ONLY_ASK_KEY]
    : input
}
