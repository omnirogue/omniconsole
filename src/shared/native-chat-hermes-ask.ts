import type { AskAnswerKeyGroup, AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt, AskQuestion } from './native-chat-ask-types'
import { optionOnlyAnswerIndices } from './native-chat-option-only-ask'

export const HERMES_CLARIFY_TOOL = 'clarify'

// Hermes' clarify tool limits (tools/clarify_tool.py MAX_CHOICES and its batch cap).
const HERMES_MAX_CHOICES = 4
const HERMES_MAX_QUESTIONS = 5

function parseClarifyQuestion(raw: unknown): AskQuestion | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const { question, choices } = raw as { question?: unknown; choices?: unknown }
  // Why: no choices means an open-ended answer typed in the TUI; one click cannot give it.
  if (typeof question !== 'string' || !Array.isArray(choices) || choices.length === 0) {
    return null
  }
  // Why all-or-nothing: a dropped blank would shift every later digit off its row.
  if (!choices.every((choice) => typeof choice === 'string' && choice.trim().length > 0)) {
    return null
  }
  return {
    question,
    // Why forced: the TUI ignores multi_select and renders every question single-select.
    multiSelect: false,
    options: (choices as string[]).slice(0, HERMES_MAX_CHOICES).map((label) => ({ label }))
  }
}

/** Hermes `clarify` input (one question or a `questions` batch); null when any is unanswerable. */
export function parseHermesClarify(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const batch = (input as { questions?: unknown }).questions
  const raw = Array.isArray(batch) ? batch : [input]
  if (raw.length === 0 || raw.length > HERMES_MAX_QUESTIONS) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const entry of raw) {
    const question = parseClarifyQuestion(entry)
    if (!question) {
      return null
    }
    questions.push(question)
  }
  return { questions }
}

/** Hermes' TUI: a digit locks that choice and moves to the next unanswered question; the last submits. */
export function buildHermesAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const answers = optionOnlyAnswerIndices(prompt, selections, { allowMultiSelect: false })
  return answers
    ? answers.map(([index], question) => ({ raw: String(index! + 1), screen: question }))
    : []
}
