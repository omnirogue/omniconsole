import { ensureSessionDataRuntime } from '@/lib/session-data-runtime'
import { useCallback } from 'react'
import { useSessionDataScope, sessionDataScopeKey } from '@/lib/session-data-scope'
import { useSessionDataSnapshot } from '@/lib/use-session-data-snapshot'
import type { SessionDataIssue, SessionDataStatus } from '@/lib/session-data-snapshot-store'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { ConversationSource } from '../../../../shared/conversation-source'
import {
  PROMPT_QUEUE_RPC,
  type PromptQueue,
  type PromptQueueWaitReason
} from '../../../../shared/prompt-queue-types'
import {
  mutatePromptQueue,
  promptQueueSnapshotStore,
  promptQueueSourceKey
} from './prompt-queue-snapshot'

export { PROMPT_QUEUE_POLL_MS } from './prompt-queue-snapshot'

export type PromptQueueController = {
  queue: PromptQueue
  waitReason: PromptQueueWaitReason | null
  error: string | null
  status: SessionDataStatus
  issue: SessionDataIssue | null
  lastSuccessAt: number | null
  enqueue: (text: string) => Promise<void>
  remove: (entryId: string) => Promise<void>
  reorder: (entryId: string, direction: 'up' | 'down') => Promise<void>
  requeue: (entryId: string) => Promise<void>
  clearDelivered: () => Promise<void>
}

const EMPTY_SOURCE: ConversationSource = { worktreeId: '', paneKey: '', kind: 'pty' }

/** The queue remains owned by this desktop's runtime; all views share its reads and writes. */
export function usePromptQueue(
  source: ConversationSource | null,
  visible = true
): PromptQueueController {
  const scope = useSessionDataScope()
  const hasSource = source !== null
  const sourceKey = promptQueueSourceKey(source ?? EMPTY_SOURCE)
  const store = promptQueueSnapshotStore(scope, sourceKey)
  const snapshot = useSessionDataSnapshot(store, visible && hasSource)
  const mutate = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<void> => {
      if (!hasSource) {
        return
      }
      await mutatePromptQueue(scope, JSON.parse(sourceKey) as ConversationSource, method, params)
    },
    [scope, sourceKey, hasSource]
  )
  return {
    queue: snapshot.data.queue,
    waitReason: snapshot.data.waitReason,
    error: snapshot.error,
    status: snapshot.status,
    issue: snapshot.issue,
    lastSuccessAt: snapshot.lastSuccessAt,
    enqueue: useCallback(
      (text: string) =>
        mutate(PROMPT_QUEUE_RPC.enqueue, { id: crypto.randomUUID(), text: text.trim() }),
      [mutate]
    ),
    remove: useCallback(
      (entryId: string) => mutate(PROMPT_QUEUE_RPC.remove, { entryId }),
      [mutate]
    ),
    reorder: useCallback(
      (entryId: string, direction: 'up' | 'down') =>
        mutate(PROMPT_QUEUE_RPC.reorder, { entryId, direction }),
      [mutate]
    ),
    requeue: useCallback(
      (entryId: string) => mutate(PROMPT_QUEUE_RPC.requeue, { entryId }),
      [mutate]
    ),
    clearDelivered: useCallback(() => mutate(PROMPT_QUEUE_RPC.clearDelivered, {}), [mutate])
  }
}

export async function readPromptQueueOnce(source: ConversationSource): Promise<PromptQueue> {
  const result = await callRuntimeRpc<{ queue: PromptQueue }>(
    { kind: 'local' },
    PROMPT_QUEUE_RPC.list,
    { source }
  )
  return result.queue
}

export async function enqueuePromptOnce(
  source: ConversationSource,
  text: string
): Promise<PromptQueue> {
  await ensureSessionDataRuntime()
  return mutatePromptQueue(
    sessionDataScopeKey(useAppStore.getState()),
    source,
    PROMPT_QUEUE_RPC.enqueue,
    { id: crypto.randomUUID(), text: text.trim() }
  )
}
