import { withTimeout } from '../../shared/promise-timeout-fallback'

/**
 * One reading of the session after the answer's key. Only `left` (a positive reading of a
 * different, known state with the prompt gone from its screen) counts toward confirming, and one
 * `left` alone never confirms; a screen that cannot be read or parsed is `unreadable`, never taken
 * for the prompt having closed.
 */
export type PromptExitReading =
  | { kind: 'left' }
  | { kind: 'waiting' }
  | { kind: 'unreadable'; reason: string }

export type PromptExitOutcome = { status: 'confirmed' } | { status: 'unconfirmed'; reason: string }

const CONFIRM_WINDOW_MS = 2000
/** Two `left` readings at least this far apart, nothing else between: one could catch a redraw. */
export const CONSISTENT_LEFT_MS = 300

type Settled = PromptExitReading | { kind: 'failed'; error: unknown } | { kind: 'timed-out' }

export async function confirmSessionPromptExit(
  check: () => Promise<PromptExitReading>
): Promise<PromptExitOutcome> {
  const deadline = Date.now() + CONFIRM_WINDOW_MS
  let reason = 'no reading of the session finished within 2 seconds'
  let leftSince: number | null = null
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())))
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      break
    }
    const attempt: Promise<Settled> = Promise.resolve()
      .then(check)
      .catch((error: unknown) => ({ kind: 'failed' as const, error }))
    const reading = await withTimeout<Settled>(attempt, remaining, { kind: 'timed-out' })
    if (reading.kind === 'left') {
      const now = Date.now()
      if (leftSince !== null && now - leftSince >= CONSISTENT_LEFT_MS) {
        return { status: 'confirmed' }
      }
      leftSince ??= now
      reason = 'only one reading showed the prompt gone'
      continue
    }
    leftSince = null
    if (reading.kind === 'failed') {
      // A lost read after writing cannot erase the audit of the attempted answer.
      const message = reading.error instanceof Error ? reading.error.message : String(reading.error)
      return { status: 'unconfirmed', reason: `a reading after the key failed: ${message}` }
    }
    if (reading.kind === 'timed-out') {
      return { status: 'unconfirmed', reason: 'a reading after the key did not finish in time' }
    }
    reason = reading.kind === 'waiting' ? 'the prompt was still showing' : reading.reason
  }
  return { status: 'unconfirmed', reason }
}
