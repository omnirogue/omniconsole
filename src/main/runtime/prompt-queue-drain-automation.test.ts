/**
 * A deliverable check's repair prompt is written as an unattended writer, as Keep going and the
 * steward are: an SSH relay applies the hard stops it keeps for automation, never the person's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const deliveries = vi.hoisted(() => [] as { text: string; unattended: boolean | undefined }[])
vi.mock('./conversation-delivery', () => ({
  deliverToConversation: async (
    _runtime: unknown,
    _source: unknown,
    text: string,
    options: { beforeWrite?: () => void; unattended?: boolean }
  ) => {
    options.beforeWrite?.()
    deliveries.push({ text, unattended: options.unattended })
    return { door: 'pty' as const, deliveredAt: 1 }
  }
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { PromptQueueEnqueueInput } from '../../shared/prompt-queue-types'
import type { DeliverableVerifierService } from '../deliverable-verifier/deliverable-verifier-service'
import { setDeliverableVerifier } from '../deliverable-verifier/deliverable-verifier-slot'
import type { OrcaRuntimeService } from './omni-runtime'
import { drainPromptQueues } from './prompt-queue-drain'

const SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const ROW = conversationSourceRowKey(SOURCE)

/** A queued entry as the drain finds it: the queue's own stamps beside the caller's input. */
function runtimeWith(entry: PromptQueueEnqueueInput & { createdAt: number; state: 'queued' }): {
  runtime: OrcaRuntimeService
  persistence: PromptQueuePersistence
} {
  const persistence = new PromptQueuePersistence(
    {
      state: { promptQueues: {} } as unknown as PersistedState,
      flushOrThrow: () => {},
      writesFrozen: false
    },
    {} as WriteSchedulingOperations
  )
  persistence.enqueuePromptQueueEntry(SOURCE, entry)
  const runtime = {
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (rowKey: string) => persistence.readPromptQueue(rowKey),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => persistence.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => persistence.settlePromptQueueEntry(...args),
    listSessionChains: () => [],
    resolveTerminalPane: () => ({ handle: 'h', worktreeId: 'wt' }),
    getFreshAgentHookStatusForHandle: () => ({
      state: 'done',
      stateStartedAt: 10,
      lastAssistantMessage: 'Finished.'
    }),
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    assertTerminalAgentProcess: async () => {}
  } as unknown as OrcaRuntimeService
  return { runtime, persistence }
}

afterEach(() => {
  deliveries.length = 0
  setDeliverableVerifier(null)
})

describe('a repair prompt in the drain', () => {
  it('is delivered as an unattended writer, after its own guard passes', async () => {
    const assertDelivery = vi.fn()
    setDeliverableVerifier({ assertDelivery } as unknown as DeliverableVerifierService)
    const { runtime, persistence } = runtimeWith({
      id: 'deliverable-repair:r1:1',
      text: '[from Deliverable check 1/2 · dv-ab12cd34] Finish docs/spec.md.',
      createdAt: 1,
      state: 'queued',
      automation: { kind: 'deliverable-repair', verificationId: 'v1', attempt: 1 }
    })
    await drainPromptQueues(runtime, { epoch: 'epoch-1' })
    expect(assertDelivery).toHaveBeenCalled()
    expect(deliveries).toEqual([
      { text: '[from Deliverable check 1/2 · dv-ab12cd34] Finish docs/spec.md.', unattended: true }
    ])
    expect(persistence.readPromptQueue(ROW)?.entries[0]?.state).toBe('delivered')
  })

  it('keeps the person’s own prompt attended', async () => {
    const { runtime } = runtimeWith({
      id: 'p1',
      text: 'Now plan it',
      createdAt: 1,
      state: 'queued'
    })
    await drainPromptQueues(runtime, { epoch: 'epoch-1' })
    expect(deliveries).toEqual([{ text: 'Now plan it', unattended: false }])
  })
})
