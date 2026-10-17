import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { GoalsTodosDetails } from './goals-todos-rows'
import {
  cachedGoalsTodosDetails,
  goalsTodosVersion,
  registerGoalsTodosConsumer,
  subscribeGoalsTodos,
  type GoalsTodosReadRequest
} from './goals-todos-store'

/**
 * Asks the shared scheduler to keep these sessions read, without re-rendering the caller when
 * a read lands. Surfaces that show the results subscribe separately (see below).
 */
export function useGoalsTodosReads(requests: readonly GoalsTodosReadRequest[]): void {
  const [consumer] = useState(registerGoalsTodosConsumer)
  useEffect(() => () => consumer.dispose(), [consumer])
  useEffect(() => {
    consumer.update(requests)
  }, [consumer, requests])
}

/** The goal and list read for each requested session, as far as reads have completed. */
export function useGoalsTodosDetails(
  requests: readonly GoalsTodosReadRequest[]
): ReadonlyMap<string, GoalsTodosDetails> {
  useGoalsTodosReads(requests)
  const version = useSyncExternalStore(subscribeGoalsTodos, goalsTodosVersion)
  return useMemo(() => {
    // Why the void: a completed read bumps the version; the cache it filled is the result.
    void version
    const details = new Map<string, GoalsTodosDetails>()
    for (const request of requests) {
      const cached = cachedGoalsTodosDetails(request.key)
      if (cached) {
        details.set(request.key, cached)
      }
    }
    return details
  }, [requests, version])
}

/**
 * One session's last read, for a row or panel. Why a per-key snapshot: a read of another
 * session leaves this value's identity unchanged, so only the row it belongs to re-renders.
 */
export function useGoalsTodosEntry(key: string | null): GoalsTodosDetails | null {
  return useSyncExternalStore(subscribeGoalsTodos, () =>
    key === null ? null : cachedGoalsTodosDetails(key)
  )
}
