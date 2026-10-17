import { useEffect } from 'react'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import type { SessionBatchOrigins } from '@/lib/session-batch-origins'

type LoadableSessionState = { loaded: boolean; load: () => void }

/** Load each persisted organization store once, independently; returns the batch-origin folders. */
export function useSessionSidebarLoad(
  { loaded, load }: LoadableSessionState,
  { loaded: viewLoaded, load: loadView }: LoadableSessionState
): SessionBatchOrigins['folders'] {
  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [load, loaded])
  useEffect(() => {
    if (!viewLoaded) {
      loadView()
    }
  }, [loadView, viewLoaded])
  useEffect(() => useSessionBatchOrigins.getState().load(), [])
  return useSessionBatchOrigins((state) => state.data.folders)
}
