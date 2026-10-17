/**
 * Turns an answer given on OmniOS ({question text: answer text}) into the per-question selections
 * the desktop's own question card would have produced, so it types through the same send path.
 *
 * Answer text contract (shared with the OmniOS Questions page): a single-select answer is the
 * picked option's label, or free text; a multi-select answer is the picked labels joined by ", "
 * (or new lines), optionally followed by free text; a missing or empty answer skips that question.
 */

import type { AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
const SEPARATOR = /^\s*[,;]\s*/

function answerFor(
  answers: Record<string, string>,
  question: AskQuestion,
  index: number,
  prompt: AskPrompt
): string {
  const entries = Object.entries(answers)
  const byText = entries.find(([key]) => squash(key) === squash(question.question))
  const byHeader = question.header
    ? entries.find(([key]) => squash(key) === squash(question.header ?? ''))
    : undefined
  const lone = prompt.questions.length === 1 && entries.length === 1 ? entries[0] : undefined
  const byIndex = entries.find(([key]) => key === `#${index + 1}`)
  return (byText ?? byHeader ?? byIndex ?? lone)?.[1]?.trim() ?? ''
}

function singleSelection(question: AskQuestion, text: string): AskAnswerSelection {
  const index = question.options.findIndex((option) => squash(option.label) === squash(text))
  return index !== -1 ? { indices: [index] } : { indices: [], other: oneLine(text) }
}

/** The agent's free-text field submits on Enter, so a typed newline would cut the answer short. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/** Longest labels first, each consumed only as a whole item, so "A, B" never matches inside a label. */
function multiSelection(question: AskQuestion, text: string): AskAnswerSelection {
  const labels = question.options
    .map((option, index) => ({ index, label: squash(option.label) }))
    .filter((entry) => entry.label.length > 0)
    .sort((a, b) => b.label.length - a.label.length)
  const picked = new Set<number>()
  let rest = text.replace(/\s*\n\s*/g, ', ').trim()
  for (;;) {
    const lowered = squash(rest)
    const hit = labels.find(
      (entry) =>
        !picked.has(entry.index) &&
        lowered.startsWith(entry.label) &&
        (lowered.length === entry.label.length || SEPARATOR.test(lowered.slice(entry.label.length)))
    )
    if (!hit) {
      break
    }
    picked.add(hit.index)
    rest = consumeLabel(rest, hit.label).replace(SEPARATOR, '')
  }
  const other = oneLine(rest)
  return {
    indices: [...picked].sort((a, b) => a - b),
    ...(other ? { other } : {})
  }
}

/** Drop the leading label from `text`, matching it the way `squash` compares (case, whitespace). */
function consumeLabel(text: string, label: string): string {
  let at = 0
  let matched = 0
  const source = text.trimStart()
  while (at < source.length && matched < label.length) {
    const char = source[at]
    if (/\s/.test(char)) {
      if (label[matched] === ' ') {
        matched += 1
      }
      while (at < source.length && /\s/.test(source[at])) {
        at += 1
      }
      continue
    }
    matched += 1
    at += 1
  }
  return source.slice(at)
}

/** Selections in question order; a question with no answer stays empty (skipped). */
export function omniosAnswerSelections(
  prompt: AskPrompt,
  answers: Record<string, string>
): AskAnswerSelection[] {
  return prompt.questions.map((question, index) => {
    const text = answerFor(answers, question, index, prompt)
    if (!text) {
      return { indices: [] }
    }
    return question.multiSelect ? multiSelection(question, text) : singleSelection(question, text)
  })
}
