// Why: a tab is created synchronously, so a second click a moment later would start a
// second session; anything later than this window is a deliberate new launch.
export const REPEAT_LAUNCH_WINDOW_MS = 1500

/** Remembers the last launch per key so repeated clicks within a short window are ignored. */
export function createRepeatLaunchGuard(windowMs = REPEAT_LAUNCH_WINDOW_MS): {
  tryAcquire: (key: string, now: number) => boolean
  /** Forget a key whose launch did not start, so the next click is not refused. */
  release: (key: string) => void
} {
  const lastLaunchAt = new Map<string, number>()
  return {
    tryAcquire: (key, now) => {
      const last = lastLaunchAt.get(key)
      if (last !== undefined && now - last < windowMs) {
        return false
      }
      lastLaunchAt.set(key, now)
      return true
    },
    release: (key) => {
      lastLaunchAt.delete(key)
    }
  }
}
