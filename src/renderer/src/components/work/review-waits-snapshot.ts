import { ensureSessionDataRuntime } from '@/lib/session-data-runtime'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isSessionDataScopeCurrent } from '@/lib/session-data-scope'
import {
  createSessionDataSnapshotStore,
  type SessionDataSnapshotStore
} from '@/lib/session-data-snapshot-store'
import type { ReviewWaitItem, ReviewWaitsResult } from '../../../../shared/artifact-review-waits'

export const REVIEW_WAITS_POLL_MS = 60_000
export type ReviewWaitsData = {
  items: ReviewWaitItem[]
  inbox: 'ok' | 'unavailable' | 'signed-out'
}
const stores = new Map<string, SessionDataSnapshotStore<ReviewWaitsData>>()

export function reviewWaitsSnapshotStore(scope: string): SessionDataSnapshotStore<ReviewWaitsData> {
  let store = stores.get(scope)
  if (!store) {
    store = createSessionDataSnapshotStore({
      initial: { items: [], inbox: 'ok' } as ReviewWaitsData,
      intervalMs: REVIEW_WAITS_POLL_MS,
      current: () => isSessionDataScopeCurrent(scope),
      empty: (data) => data.items.length === 0,
      async read() {
        await ensureSessionDataRuntime()
        if (!isSessionDataScopeCurrent(scope)) {
          return {}
        }
        const result = await callRuntimeRpc<ReviewWaitsResult>(
          { kind: 'local' },
          'artifacts.reviewWaits',
          undefined,
          { timeoutMs: 30_000 }
        )
        if (result.status !== 'ok') {
          return { issue: result.status }
        }
        return {
          data: { items: result.items, inbox: result.inbox },
          ...(result.inbox !== 'ok' ? { issue: result.inbox } : {})
        }
      }
    })
    stores.set(scope, store)
  }
  return store
}
