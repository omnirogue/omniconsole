import { useEffect } from 'react'

/** How often "I've logged in" re-checks the saved session, and how long it waits. */
export const BROWSER_LOGIN_POLL_INTERVAL_MS = 3000
export const BROWSER_LOGIN_POLL_TIMEOUT_MS = 3 * 60 * 1000

export type BrowserLoginPollOutcome = 'continue' | 'verified' | 'error' | 'timed_out'

/**
 * The polling state machine for the re-login flow, as a pure function of what the
 * hub last reported and how long this poll has been running: keep checking, or
 * stop because the session verified, the hub reported an error, or the 3-minute
 * budget ran out with neither. Kept pure and separate from the `setTimeout` loop
 * around it so the decision itself can be tested without a timer.
 */
export function nextBrowserLoginPollOutcome(
  loginStatus: string,
  elapsedMs: number
): BrowserLoginPollOutcome {
  if (loginStatus === 'verified') {
    return 'verified'
  }
  if (loginStatus === 'error') {
    return 'error'
  }
  if (elapsedMs >= BROWSER_LOGIN_POLL_TIMEOUT_MS) {
    return 'timed_out'
  }
  return 'continue'
}

/**
 * Poll one profile's status every `BROWSER_LOGIN_POLL_INTERVAL_MS` while `active`,
 * reporting each outcome; the caller stops `active` once the outcome is no longer
 * `'continue'`. Overlapping requests never happen — the next poll is scheduled
 * only after the previous one settles.
 */
export function useBrowserLoginStatusPolling({
  active,
  checkStatus,
  onOutcome
}: {
  active: boolean
  checkStatus: () => Promise<string>
  onOutcome: (outcome: BrowserLoginPollOutcome, loginStatus: string) => void
}): void {
  useEffect(() => {
    if (!active) {
      return
    }
    let stopped = false
    let timeoutId: number | null = null
    const startedAt = Date.now()

    const clearPending = (): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const tick = (): void => {
      if (stopped) {
        return
      }
      void checkStatus()
        .then((loginStatus) => {
          if (stopped) {
            return
          }
          const outcome = nextBrowserLoginPollOutcome(loginStatus, Date.now() - startedAt)
          onOutcome(outcome, loginStatus)
          if (outcome === 'continue' && !stopped) {
            timeoutId = window.setTimeout(tick, BROWSER_LOGIN_POLL_INTERVAL_MS)
          }
        })
        .catch(() => {
          if (!stopped) {
            onOutcome('error', 'error')
          }
        })
    }

    timeoutId = window.setTimeout(tick, BROWSER_LOGIN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearPending()
    }
    // Why: `checkStatus`/`onOutcome` are rebuilt on every render by design; `active`
    // alone starts and stops one poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}
