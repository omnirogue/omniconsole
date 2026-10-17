import type { AskPrompt } from './native-chat-ask-types'

// Claude's question selector always ends on this footer, and its review step on this line.
const SELECTOR_FOOTER = 'Esc to cancel'
const SELECTOR_MARKERS = ['Enter to select', 'Ready to submit your answers?']

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * True while the terminal still shows this prompt's selector. An accepted PTY write is
 * not an answer: the keys can land on the wrong row (STA-1860) or on a layout that only
 * moves the highlight, and the agent then waits forever behind a card that looks sent.
 * Matching needs the selector chrome AND one of this prompt's own headers or questions,
 * so an unrelated later question cannot hold a delivered answer open.
 */
export function isClaudeAskSelectorOpen(
  screen: string | null | undefined,
  prompt: Pick<AskPrompt, 'questions'>
): boolean {
  if (!screen) {
    return false
  }
  const text = squash(screen)
  if (!text.includes(SELECTOR_FOOTER) || !SELECTOR_MARKERS.some((m) => text.includes(m))) {
    return false
  }
  return prompt.questions.some((question) => {
    const header = squash(question.header ?? '')
    // Why a prefix: a long question wraps, and the wrap point depends on the pane width.
    const opening = squash(question.question).slice(0, 32)
    return (
      (header.length > 0 && text.includes(header)) || (opening.length > 0 && text.includes(opening))
    )
  })
}
