import { ensureSessionDataRuntime } from '@/lib/session-data-runtime'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isSessionDataScopeCurrent } from '@/lib/session-data-scope'
import {
  createSessionDataSnapshotStore,
  type SessionDataSnapshotStore
} from '@/lib/session-data-snapshot-store'
import {
  normalizeConversationSource,
  type ConversationSource
} from '../../../../shared/conversation-source'
import {
  emptyPromptQueue,
  PROMPT_QUEUE_RPC,
  type PromptQueue,
  type PromptQueueWaitReason
} from '../../../../shared/prompt-queue-types'

export const PROMPT_QUEUE_POLL_MS = 2_000
export type PromptQueueData = { queue: PromptQueue; waitReason: PromptQueueWaitReason | null }
const stores = new Map<string, SessionDataSnapshotStore<PromptQueueData>>()

export function promptQueueSourceKey(source: ConversationSource): string {
  return JSON.stringify(normalizeConversationSource(source) ?? source)
}

export function promptQueueSnapshotStore(
  scope: string,
  sourceKey: string
): SessionDataSnapshotStore<PromptQueueData> {
  const key = JSON.stringify([scope, sourceKey])
  let store = stores.get(key)
  if (!store) {
    const source = JSON.parse(sourceKey) as ConversationSource
    store = createSessionDataSnapshotStore({
      initial: { queue: emptyPromptQueue(source), waitReason: null } as PromptQueueData,
      intervalMs: PROMPT_QUEUE_POLL_MS,
      current: () => isSessionDataScopeCurrent(scope),
      empty: (data) => data.queue.entries.length === 0,
      async read() {
        await ensureSessionDataRuntime()
        if (!isSessionDataScopeCurrent(scope)) {
          return {}
        }
        const result = await callRuntimeRpc<{
          queue: PromptQueue
          waitReason?: PromptQueueWaitReason
        }>({ kind: 'local' }, PROMPT_QUEUE_RPC.list, { source })
        return { data: { queue: result.queue, waitReason: result.waitReason ?? null } }
      }
    })
    stores.set(key, store)
  }
  return store
}

export async function mutatePromptQueue(
  scope: string,
  source: ConversationSource,
  method: string,
  params: Record<string, unknown>
): Promise<PromptQueue> {
  await ensureSessionDataRuntime()
  const store = promptQueueSnapshotStore(scope, promptQueueSourceKey(source))
  const data = await store.mutate(async (previous) => {
    const result = await callRuntimeRpc<{ queue: PromptQueue }>({ kind: 'local' }, method, {
      source,
      ...params
    })
    return { queue: result.queue, waitReason: previous.waitReason }
  })
  return data.queue
}
