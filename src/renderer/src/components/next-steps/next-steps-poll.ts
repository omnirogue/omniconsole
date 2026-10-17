import { NEXT_STEPS_POLL_MS } from '../../../../shared/next-step-suggestions-rpc'

/** Only while the window is on screen: the host pushes nothing, so a hidden poll is waste. */
export function nextStepsDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Calls `read` now, at the prompt queue's pace, and again as soon as the window or tab comes
 * back into view. Returns the stop function.
 */
export function startNextStepsPoll(read: () => void): () => void {
  read()
  const timer = setInterval(read, NEXT_STEPS_POLL_MS)
  const onVisible = (): void => {
    if (nextStepsDocumentVisible()) {
      read()
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onVisible)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    clearInterval(timer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onVisible)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
