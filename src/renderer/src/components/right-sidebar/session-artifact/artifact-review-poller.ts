export const ARTIFACT_REVIEW_POLL_INTERVAL_MS = 15_000

export type ArtifactReviewPoller = {
  start: () => void
  stop: () => void
}

type TimerApi = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Re-check one artifact while its view is on screen: once on start, then one interval after each
 * answer (never overlapping). `stop` cancels the next check and drops an answer still in flight,
 * so a hidden panel neither polls nor repaints.
 */
export function createArtifactReviewPoller<T>({
  load,
  onResult,
  intervalMs = ARTIFACT_REVIEW_POLL_INTERVAL_MS,
  timers = defaultTimers
}: {
  load: () => Promise<T>
  onResult: (result: T | null) => void
  intervalMs?: number
  timers?: TimerApi
}): ArtifactReviewPoller {
  let generation = 0
  let timer: unknown = null

  const clearTimer = (): void => {
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  const tick = (current: number): void => {
    timer = null
    load()
      .then(
        (result) => {
          if (current === generation) {
            onResult(result)
          }
        },
        () => {
          // Why null and keep polling: a network blip must not freeze the pill on stale state.
          if (current === generation) {
            onResult(null)
          }
        }
      )
      .finally(() => {
        if (current === generation) {
          timer = timers.setTimeout(() => tick(current), intervalMs)
        }
      })
  }

  return {
    start: () => {
      clearTimer()
      generation += 1
      tick(generation)
    },
    stop: () => {
      generation += 1
      clearTimer()
    }
  }
}
