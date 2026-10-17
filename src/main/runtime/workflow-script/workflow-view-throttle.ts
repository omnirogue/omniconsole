export type WorkflowViewThrottle = {
  /** Requests a run; bursts collapse into one leading and one trailing run per interval. */
  schedule: () => void
  close: () => void
}

/**
 * Runs `work` at most once per `intervalMs`. Runs never overlap, and a request that arrives while
 * a run is waiting or in flight is always followed by one more run, so the last state is emitted.
 */
export function createWorkflowViewThrottle(
  work: () => Promise<void> | void,
  intervalMs: number
): WorkflowViewThrottle {
  let last = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let dirty = false
  let closed = false
  const fire = async (): Promise<void> => {
    timer = undefined
    if (closed) {
      return
    }
    running = true
    dirty = false
    last = Date.now()
    try {
      await work()
    } catch {
      // The next change schedules another run; one failed projection must not end the stream.
    } finally {
      running = false
    }
    if (dirty) {
      schedule()
    }
  }
  const schedule = (): void => {
    if (closed) {
      return
    }
    if (running) {
      dirty = true
      return
    }
    if (timer) {
      return
    }
    timer = setTimeout(() => void fire(), Math.max(0, last + intervalMs - Date.now()))
  }
  return {
    schedule,
    close: () => {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }
}
