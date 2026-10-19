/** Needs you's own questions list (Settings › Sessions). */
export type SessionQuestionsSettings = {
  /** Show each pending question in Needs you with its options as one-click answers. On by default. */
  inlineAnswers: boolean
  /** Also surface a question a Claude or Codex reply ends on (not only sign-in links) as a waiting
   *  question in the sidebar, Needs you and OmniOS. Off by default: it stops Outcome runs for the person. */
  turnEndQuestions: boolean
}

export function getDefaultSessionQuestionsSettings(): SessionQuestionsSettings {
  return { inlineAnswers: true, turnEndQuestions: false }
}

/** Persisted or hand-edited input: inline answers on unless `false`; turn-end questions off unless `true`. */
export function normalizeSessionQuestionsSettings(raw: unknown): SessionQuestionsSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    inlineAnswers: value.inlineAnswers !== false,
    turnEndQuestions: value.turnEndQuestions === true
  }
}
