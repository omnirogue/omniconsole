/** One cap for every lifecycle call on the page (row, bulk and undo): at most `limit` in flight. */
export type ArtifactLifecycleGate = {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

export function createArtifactLifecycleGate(limit: number): ArtifactLifecycleGate {
  let active = 0
  const waiting: (() => void)[] = []
  // Why hand the slot over: releasing first would let a new caller slip in ahead of a waiter.
  const release = (): void => {
    const next = waiting.shift()
    if (next) {
      next()
    } else {
      active -= 1
    }
  }
  return {
    run: async (task) => {
      if (active < limit) {
        active += 1
      } else {
        await new Promise<void>((resolve) => waiting.push(resolve))
      }
      try {
        return await task()
      } finally {
        release()
      }
    }
  }
}
