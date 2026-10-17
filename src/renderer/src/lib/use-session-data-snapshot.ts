import { useCallback, useSyncExternalStore } from 'react'
import { usePaneFocus } from '@/components/pane-focus-context'
import type { SessionDataSnapshot, SessionDataSnapshotStore } from './session-data-snapshot-store'

export function useSessionDataSnapshot<T>(
  store: SessionDataSnapshotStore<T>,
  visible = true
): SessionDataSnapshot<T> {
  const pane = usePaneFocus()
  const watching = visible && pane.visible
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, watching),
    [store, watching]
  )
  return useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
}
