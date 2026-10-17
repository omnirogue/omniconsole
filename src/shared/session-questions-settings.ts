/** Needs you's own questions list (Settings › Sessions): on by default. */
export type SessionQuestionsSettings = {
  /** Show each pending question in Needs you with its options as one-click answers. */
  inlineAnswers: boolean
}

export function getDefaultSessionQuestionsSettings(): SessionQuestionsSettings {
  return { inlineAnswers: true }
}

/** Persisted or hand-edited input: on unless explicitly `false`. */
export function normalizeSessionQuestionsSettings(raw: unknown): SessionQuestionsSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { inlineAnswers: value.inlineAnswers !== false }
}
