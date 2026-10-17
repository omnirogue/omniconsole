import { useCallback } from 'react'
import { useSessionDataScope } from '@/lib/session-data-scope'
import { useSessionDataSnapshot } from '@/lib/use-session-data-snapshot'
import {
  answerSessionDecision,
  sessionDecisionSnapshotStore,
  skipSessionDecision
} from './session-decision-snapshot'

/** All views share the pinned question, skipped order and immediately answered keys. */
export function useSessionDecisionQueue(visible = true) {
  const scope = useSessionDataScope()
  const store = sessionDecisionSnapshotStore(scope)
  const snapshot = useSessionDataSnapshot(store, visible)
  return {
    ...snapshot,
    loaded: snapshot.status !== 'loading',
    failed: snapshot.issue !== null,
    current: snapshot.data.current,
    position: snapshot.data.position,
    total: snapshot.data.total,
    answered: useCallback((key: string) => answerSessionDecision(store, key), [store]),
    skip: useCallback((key: string) => skipSessionDecision(store, key), [store]),
    refresh: useCallback(() => {
      store.invalidate()
    }, [store])
  }
}
