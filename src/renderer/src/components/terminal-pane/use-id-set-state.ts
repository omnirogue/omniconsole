import { useCallback, useRef, useState } from 'react'

function haveSameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

/**
 * Id-set state whose setter drops a set equal to the last one stored.
 * Why not a `current => same ? current : next` updater: right after a store-driven render React
 * cannot skip it early, so it still queues a render behind every commit, which during a startup
 * restore drove React's nested-update counter to #185.
 */
export function useIdSetState(): readonly [
  ReadonlySet<string>,
  (next: ReadonlySet<string>) => void
] {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())
  // Why the last request: every write goes through this setter and queued updates are never dropped.
  const latestRef = useRef(ids)
  const setIdsIfChanged = useCallback((next: ReadonlySet<string>) => {
    if (haveSameIdSet(latestRef.current, next)) {
      return
    }
    latestRef.current = next
    setIds(next)
  }, [])
  return [ids, setIdsIfChanged] as const
}
