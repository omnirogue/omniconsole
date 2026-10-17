import { useSessionDataScope } from '@/lib/session-data-scope'
import { useSessionDataSnapshot } from '@/lib/use-session-data-snapshot'
import { reviewWaitsSnapshotStore } from './review-waits-snapshot'

export function useReviewWaits(visible = true) {
  const scope = useSessionDataScope()
  const snapshot = useSessionDataSnapshot(reviewWaitsSnapshotStore(scope), visible)
  return {
    ...snapshot,
    items: snapshot.data.items,
    loaded: snapshot.status !== 'loading',
    inbox: snapshot.issue ?? snapshot.data.inbox
  }
}
