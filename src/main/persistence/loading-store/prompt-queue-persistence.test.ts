import { describe, expect, it, vi } from 'vitest'

vi.mock('./write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from './prompt-queue-persistence'
import { conversationSourceRowKey } from '../../../shared/conversation-source'
import {
  nextPromptQueueEntry,
  normalizePromptQueues,
  PROMPT_QUEUE_ONE_IN_FLIGHT,
  promptQueuePausedBy
} from '../../../shared/prompt-queue-types'
import type { ConversationCapacityRecovery } from '../../../shared/conversation-capacity-recovery'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from './write-scheduling'

const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const rowKey = conversationSourceRowKey(source)

function store(options: { flush?: () => void; writesFrozen?: boolean } = {}) {
  const state = { promptQueues: {} } as unknown as PersistedState
  const persistence = new PromptQueuePersistence(
    {
      state,
      flushOrThrow: options.flush ?? (() => {}),
      writesFrozen: options.writesFrozen ?? false
    },
    {} as WriteSchedulingOperations
  )
  return { state, persistence }
}

const queued = (id: string, text: string) => ({
  id,
  text,
  createdAt: 1,
  state: 'queued' as const
})

function recovery(): ConversationCapacityRecovery {
  return {
    id: 'recovery-1',
    sourceVersion: 'version-1',
    sourceProcessIncarnation: 'process-1',
    sourcePtyId: 'pty-1',
    sourceAgent: 'claude',
    sourceProviderSessionId: 'session-1',
    sourceTranscriptPath: '/accounts/source/transcript.jsonl',
    historyPath: '/workspace/.omni/handoffs/recovery-1.md',
    sourceAccountHome: '/accounts/source',
    sourceFailedAt: 10,
    detectedAt: 11,
    phase: 'prepared',
    target: {
      agent: 'codex',
      accountHome: '/accounts/target',
      accountChoiceId: 'managed:target'
    },
    successor: {
      tabId: 'tab-2',
      leafId: 'leaf-2',
      handle: 'handle-2',
      launchToken: 'launch-2',
      operationId: 'prompt-queue:recovery-1'
    },
    brief: 'Continue the original request; the file edit is saved and its check remains.',
    attemptAccounts: ['/accounts/source']
  }
}

describe('PromptQueuePersistence', () => {
  it('keeps the queue in the profile state under the conversation’s own row key', () => {
    const { state, persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    expect(Object.keys(state.promptQueues!)).toEqual([rowKey])
    expect(state.promptQueues![rowKey]!.source).toEqual(source)
  })

  it('refuses a durable receipt on a host that cannot flush, before anything is marked', () => {
    const { state, persistence } = store({ writesFrozen: true })
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    expect(() =>
      persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
        operationId: 'op',
        deliveryEpoch: 'epoch'
      })
    ).toThrow('Durable prompt-queue receipts are unavailable')
    expect(state.promptQueues![rowKey]!.entries[0]!.state).toBe('queued')
  })

  it('rolls the receipt back when the flush itself fails', () => {
    const { state, persistence } = store({
      flush: () => {
        throw new Error('disk full')
      }
    })
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    expect(() =>
      persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
        operationId: 'op',
        deliveryEpoch: 'epoch'
      })
    ).toThrow('disk full')
    expect(state.promptQueues![rowKey]!.entries[0]!.state).toBe('queued')
  })

  it('admits one entry once: a second admission of the same entry is refused', () => {
    const { persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
      operationId: 'op',
      deliveryEpoch: 'epoch'
    })
    expect(() =>
      persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
        operationId: 'op-2',
        deliveryEpoch: 'epoch'
      })
    ).toThrow('no longer waiting')
  })

  it('admits one delivery per conversation: another entry waits while one is in flight', () => {
    const { state, persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    persistence.enqueuePromptQueueEntry(source, queued('e2', 'Send this now'))
    persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e2', {
      operationId: 'op',
      deliveryEpoch: 'epoch'
    })
    expect(() =>
      persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
        operationId: 'op-2',
        deliveryEpoch: 'epoch'
      })
    ).toThrow(PROMPT_QUEUE_ONE_IN_FLIGHT)
    expect(state.promptQueues![rowKey]!.entries.map((entry) => entry.state)).toEqual([
      'queued',
      'sending'
    ])
  })

  it('will not withdraw a delivery that is already under way', () => {
    const { persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
      operationId: 'op',
      deliveryEpoch: 'epoch'
    })
    expect(persistence.removePromptQueueEntry(rowKey, 'e1')?.entries).toHaveLength(1)
  })

  it('never overwrites a settlement that already happened', () => {
    const { persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    persistence.settlePromptQueueEntry(rowKey, 'e1', {
      state: 'delivered',
      deliveredAt: 5,
      door: 'pty'
    })
    persistence.settlePromptQueueEntry(rowKey, 'e1', { state: 'failed', reason: 'too late' })
    expect(persistence.readPromptQueue(rowKey)!.entries[0]).toMatchObject({
      state: 'delivered',
      deliveredAt: 5
    })
  })

  it('drops the record once the last entry is gone', () => {
    const { state, persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Continue'))
    persistence.removePromptQueueEntry(rowKey, 'e1')
    expect(state.promptQueues).toEqual({})
  })

  it('survives a reload: what it wrote is what the loader reads back', () => {
    const { state, persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Research the code'))
    persistence.enqueuePromptQueueEntry(source, queued('e2', 'Have you done your best job?'))
    const reloaded = normalizePromptQueues(JSON.parse(JSON.stringify(state.promptQueues)))
    expect(reloaded).toEqual(state.promptQueues)
  })

  it('durably retains an empty recovery queue and successor identity across a restart', () => {
    let written: unknown
    const { state, persistence } = store({
      flush: () => {
        written = JSON.parse(JSON.stringify(state.promptQueues))
      }
    })
    persistence.saveConversationCapacityRecoveryAndFlush(source, recovery())
    const restoredState = { promptQueues: normalizePromptQueues(written) } as PersistedState
    const restored = new PromptQueuePersistence(
      { state: restoredState, flushOrThrow: () => {} },
      {} as WriteSchedulingOperations
    )
    expect(restored.readPromptQueue(rowKey)).toEqual({ source, entries: [], recovery: recovery() })
    expect(
      restored.clearDeliveredPromptQueueEntries(rowKey)?.recovery?.successor?.operationId
    ).toBe('prompt-queue:recovery-1')
  })

  it('retains a durable capacity wait across restart without inventing a target or successor', () => {
    const { state, persistence } = store()
    const waiting = { ...recovery(), phase: 'waiting-capacity' as const, sourceResetAt: 123_000 }
    delete waiting.target
    delete waiting.successor
    persistence.saveConversationCapacityRecoveryAndFlush(source, waiting)
    const restored = normalizePromptQueues(JSON.parse(JSON.stringify(state.promptQueues)))
    expect(restored[rowKey]?.recovery).toEqual(waiting)
    expect(restored[rowKey]?.recovery).not.toHaveProperty('target')
    expect(restored[rowKey]?.recovery).not.toHaveProperty('successor')
    expect(() =>
      persistence.saveConversationCapacityRecoveryAndFlush(source, {
        ...waiting,
        phase: 'prepared'
      })
    ).toThrow('capacity-recovery receipt is invalid')
  })

  it('updates or removes recovery metadata without losing queued human steering', () => {
    const { persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('human', 'Only edit the local file.'))
    persistence.saveConversationCapacityRecoveryAndFlush(source, recovery())
    persistence.saveConversationCapacityRecoveryAndFlush(source, {
      ...recovery(),
      phase: 'stopped'
    })
    expect(persistence.readPromptQueue(rowKey)?.entries).toEqual([
      queued('human', 'Only edit the local file.')
    ])
    expect(persistence.saveConversationCapacityRecoveryAndFlush(source, null)).toEqual({
      source,
      entries: [queued('human', 'Only edit the local file.')]
    })
    persistence.removePromptQueueEntry(rowKey, 'human')
    expect(persistence.readPromptQueue(rowKey)).toBeNull()
  })

  it('rolls a failed durable recovery transition back to the previous phase and messages', () => {
    const flush = vi.fn()
    const { persistence } = store({ flush })
    persistence.enqueuePromptQueueEntry(source, queued('human', 'Preserve this steering.'))
    persistence.saveConversationCapacityRecoveryAndFlush(source, recovery())
    flush.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() =>
      persistence.saveConversationCapacityRecoveryAndFlush(source, {
        ...recovery(),
        phase: 'stopped'
      })
    ).toThrow('disk full')
    expect(persistence.readPromptQueue(rowKey)).toEqual({
      source,
      entries: [queued('human', 'Preserve this steering.')],
      recovery: recovery()
    })
  })

  it('refuses recovery admission when durable writes are frozen', () => {
    const { state, persistence } = store({ writesFrozen: true })
    expect(() => persistence.saveConversationCapacityRecoveryAndFlush(source, recovery())).toThrow(
      'Durable capacity-recovery receipts are unavailable'
    )
    expect(state.promptQueues).toEqual({})
  })

  it.each([
    { phase: 'unknown' },
    { sourceFailedAt: -1 },
    { sourceProcessIncarnation: 'x'.repeat(1_001) },
    { brief: 'x'.repeat(32_001) },
    { attemptAccounts: Array.from({ length: 65 }, () => '/account') },
    { unexpectedController: true }
  ])('rejects malformed recovery without discarding valid queued messages: %o', (invalid) => {
    const raw = { ...recovery(), ...invalid }
    const { persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('human', 'Keep this.'))
    expect(() =>
      persistence.saveConversationCapacityRecoveryAndFlush(
        source,
        raw as ConversationCapacityRecovery
      )
    ).toThrow('capacity-recovery receipt is invalid')
    expect(
      normalizePromptQueues({
        [rowKey]: { source, entries: [queued('human', 'Keep this.')], recovery: raw }
      })
    ).toEqual({ [rowKey]: { source, entries: [queued('human', 'Keep this.')] } })
  })
})

describe('a queue paused behind a failed prompt', () => {
  const failFirst = () => {
    const { state, persistence } = store()
    persistence.enqueuePromptQueueEntry(source, queued('e1', 'Research the code'))
    persistence.enqueuePromptQueueEntry(source, queued('e2', 'Now plan it'))
    persistence.markPromptQueueEntrySendingAndFlush(rowKey, 'e1', {
      operationId: 'op-1',
      deliveryEpoch: 'epoch-1'
    })
    persistence.settlePromptQueueEntry(rowKey, 'e1', { state: 'failed', reason: 'gone' })
    return { state, persistence }
  }

  it('pauses when the person’s own prompt fails, and stays paused through a reload', () => {
    const { state, persistence } = failFirst()
    expect(promptQueuePausedBy(persistence.readPromptQueue(rowKey)!)?.id).toBe('e1')
    const reloaded = normalizePromptQueues(JSON.parse(JSON.stringify(state.promptQueues)))
    expect(reloaded[rowKey]!.entries[0]).toMatchObject({ state: 'failed', holdsQueue: true })
    expect(nextPromptQueueEntry(reloaded[rowKey]!)).toBeNull()
  })

  it.each([
    ['a Keep going round', { origin: { kind: 'keep-going', runToken: 'run001', round: 1 } }],
    ['another session’s request', { requestedBy: { action: 'continue', actor: 'steward' } }],
    ['a capacity-recovery brief', { id: 'capacity-recovery:r1' }]
  ])('is never paused by %s that fails', (_name, over) => {
    const { persistence } = store()
    const auto = { ...queued('auto', 'Automatic'), ...over }
    persistence.enqueuePromptQueueEntry(source, auto)
    persistence.settlePromptQueueEntry(rowKey, auto.id, { state: 'failed', reason: 'gone' })
    expect(persistence.readPromptQueue(rowKey)!.entries[0]!.holdsQueue).toBeUndefined()
  })

  it('resumes when the failed prompt is dismissed', () => {
    const { persistence } = failFirst()
    const queue = persistence.removePromptQueueEntry(rowKey, 'e1')!
    expect(promptQueuePausedBy(queue)).toBeNull()
    expect(nextPromptQueueEntry(queue)?.id).toBe('e2')
  })

  it('queues it again at the head, under a new id, and resumes', () => {
    const { persistence } = failFirst()
    const queue = persistence.requeuePromptQueueEntry(rowKey, 'e1', {
      id: 'e1-again',
      createdAt: 5
    })!
    expect(queue.entries).toEqual([
      { id: 'e1-again', text: 'Research the code', createdAt: 5, state: 'queued' },
      expect.objectContaining({ id: 'e2', state: 'queued' })
    ])
    expect(nextPromptQueueEntry(queue)?.id).toBe('e1-again')
  })

  it('queues again only a failed prompt of the person’s own', () => {
    const { persistence } = failFirst()
    expect(() =>
      persistence.requeuePromptQueueEntry(rowKey, 'e2', { id: 'x', createdAt: 5 })
    ).toThrow('no longer waiting to be queued again')
    persistence.enqueuePromptQueueEntry(source, {
      ...queued('kg', 'Keep going'),
      origin: { kind: 'keep-going', runToken: 'run001', round: 1 }
    })
    persistence.settlePromptQueueEntry(rowKey, 'kg', { state: 'failed', reason: 'stopped' })
    expect(() =>
      persistence.requeuePromptQueueEntry(rowKey, 'kg', { id: 'y', createdAt: 5 })
    ).toThrow('no longer waiting to be queued again')
  })
})
