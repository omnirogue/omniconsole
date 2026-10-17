import type { AskPrompt } from './native-chat-interactive-prompt'
import { isClaudeAskSelectorOpen } from '../../../../shared/claude-ask-selector-screen'

export { isClaudeAskSelectorOpen }

/** How long an answered Claude selector may take to leave the screen. */
export const CLAUDE_ASK_CLOSE_CHECK_MS = 400
export const CLAUDE_ASK_CLOSE_CHECKS = 4

/**
 * Resolve true once the selector has left the screen, false if it is still up after
 * the last check. Without a screen reader the accepted write is the only evidence.
 */
export function waitForClaudeAskSelectorClosed(args: {
  prompt: AskPrompt
  readScreen: (() => string | null) | undefined
  isCancelled: () => boolean
  onResult: (closed: boolean) => void
}): () => void {
  const { prompt, readScreen, isCancelled, onResult } = args
  if (!readScreen) {
    onResult(true)
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let checks = 0
  const check = (): void => {
    timer = null
    if (isCancelled()) {
      return
    }
    let open = false
    try {
      open = isClaudeAskSelectorOpen(readScreen(), prompt)
    } catch {
      // An unreadable screen proves nothing either way; keep the accepted write.
    }
    checks += 1
    if (!open) {
      onResult(true)
    } else if (checks >= CLAUDE_ASK_CLOSE_CHECKS) {
      onResult(false)
    } else {
      timer = setTimeout(check, CLAUDE_ASK_CLOSE_CHECK_MS)
    }
  }
  check()
  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
