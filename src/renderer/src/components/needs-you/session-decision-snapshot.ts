import { ensureSessionDataRuntime } from '@/lib/session-data-runtime'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isSessionDataScopeCurrent } from '@/lib/session-data-scope'
import {
  createSessionDataSnapshotStore,
  type SessionDataSnapshotStore
} from '@/lib/session-data-snapshot-store'
import {
  SESSION_DECISIONS_RPC,
  orderDecisions,
  type SessionDecision,
  type SessionDecisionsResult
} from '../../../../shared/session-decisions'

export const SESSION_DECISIONS_POLL_MS = 3_000

type DecisionQueue = {
  decisions: SessionDecision[]
  done: ReadonlySet<string>
  skipped: readonly string[]
  pinned: string | null
  current: SessionDecision | null
  position: number
  total: number
}

function orderedQueue(data: DecisionQueue): DecisionQueue {
  const open = orderDecisions(data.decisions.filter((decision) => !data.done.has(decision.key)))
  const later = new Set(data.skipped)
  const byKey = new Map(open.map((decision) => [decision.key, decision]))
  const queue = [
    ...open.filter((decision) => !later.has(decision.key)),
    ...data.skipped.flatMap((key) => {
      const decision = byKey.get(key)
      return decision ? [decision] : []
    })
  ]
  const current = queue.find((decision) => decision.key === data.pinned) ?? queue[0] ?? null
  return {
    ...data,
    current,
    pinned: current?.key ?? null,
    position: current ? queue.indexOf(current) + 1 : 0,
    total: queue.length
  }
}

const stores = new Map<string, SessionDataSnapshotStore<DecisionQueue>>()

export function sessionDecisionSnapshotStore(
  scope: string
): SessionDataSnapshotStore<DecisionQueue> {
  let store = stores.get(scope)
  if (!store) {
    store = createSessionDataSnapshotStore({
      initial: orderedQueue({
        decisions: [],
        done: new Set(),
        skipped: [],
        pinned: null,
        current: null,
        position: 0,
        total: 0
      }),
      intervalMs: SESSION_DECISIONS_POLL_MS,
      current: () => isSessionDataScopeCurrent(scope),
      empty: (data) => data.total === 0,
      async read(previous) {
        await ensureSessionDataRuntime()
        if (!isSessionDataScopeCurrent(scope)) {
          return {}
        }
        const result = await callRuntimeRpc<SessionDecisionsResult>(
          { kind: 'local' },
          SESSION_DECISIONS_RPC.list,
          {}
        )
        return { data: orderedQueue({ ...previous, decisions: result.decisions }) }
      }
    })
    stores.set(scope, store)
  }
  return store
}

export function answerSessionDecision(
  store: SessionDataSnapshotStore<DecisionQueue>,
  key: string
): void {
  store.update((data) =>
    orderedQueue({ ...data, done: new Set([...data.done, key]), pinned: null })
  )
  store.invalidate()
}

export function skipSessionDecision(
  store: SessionDataSnapshotStore<DecisionQueue>,
  key: string
): void {
  store.update((data) =>
    orderedQueue({
      ...data,
      skipped: [...data.skipped.filter((entry) => entry !== key), key],
      pinned: null
    })
  )
}
