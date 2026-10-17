import { DecisionProviderError } from '../../shared/structured-decisions'

export function decisionAbortError(signal: AbortSignal): DecisionProviderError {
  return signal.reason instanceof DecisionProviderError
    ? signal.reason
    : new DecisionProviderError('cancelled')
}

export async function abortableDecisionWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined)
    throw decisionAbortError(signal)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(decisionAbortError(signal))
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function waitForDecisionRetry(delay: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(decisionAbortError(signal))
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort)
        resolve()
      },
      Math.max(0, delay)
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })
}
