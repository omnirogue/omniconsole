// Why: main-process errors arrive verbatim and speak of "transcript"/"recording",
// words the chat surface never shows; it calls the same thing conversation history.
const INTERNAL_HISTORY_TERM_RE = /\b(transcript|recording)s?\b/gi

export function describeNativeChatHistoryError(error: string): string {
  return error.replace(INTERNAL_HISTORY_TERM_RE, (term) =>
    /^[A-Z]/.test(term) ? 'Conversation history' : 'conversation history'
  )
}
