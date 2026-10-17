// Canonical AskUserQuestion prompt types consumed by the shared parser and both
// native-chat platform UIs.

/** `preview` is Claude's side-by-side preview text. Its presence switches the
 *  terminal selector to a layout where option numbers only move the highlight. */
export type AskOption = { label: string; description?: string; preview?: string }
export type AskQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  /** An async question's own identity: when its agent asked it (`codex-async-question.ts`). */
  askedAt?: number
  options: AskOption[]
  /** Gemini's custom-answer row text when the model set one (instead of "Enter a custom value"). */
  placeholder?: string
}
/** `delivery: 'async'`: the agent took no selector (Codex's `request_user_input_async`); it is
 *  answered with a message. */
export type AskPrompt = { questions: AskQuestion[]; delivery?: 'async' }

/** A parser turns one agent's interactive-question tool input into the normalized
 *  AskPrompt the card renders. */
export type InteractiveQuestionParser = (input: unknown) => AskPrompt | null
