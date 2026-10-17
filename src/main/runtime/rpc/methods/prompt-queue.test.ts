/**
 * The six prompt-queue methods, against the real store domain.
 *
 * Two things are checked here that nothing else can check: that an agent cannot
 * queue a message into a person's conversation, and that none of these calls
 * leaves a chain, an outcome set or a plan behind — this is ordinary conversation.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../../../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey } from '../../../../shared/conversation-source'
import { PROMPT_QUEUE_RPC, type PromptQueue } from '../../../../shared/prompt-queue-types'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../../../persistence/loading-store/write-scheduling'
import type { RpcContext, RpcMethod } from '../core'
import { PROMPT_QUEUE_METHODS } from './prompt-queue'

const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const rowKey = conversationSourceRowKey(source)

function context(over: Partial<RpcContext> = {}): {
  ctx: RpcContext
  state: PersistedState
  call: (name: string, params: unknown) => { queue: PromptQueue; waitReason?: unknown }
} {
  const state = { promptQueues: {} } as unknown as PersistedState
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const ctx = {
    clientId: 'desktop-renderer',
    runtime: {
      readPromptQueue: (key: string) => persistence.readPromptQueue(key),
      enqueuePromptQueueEntry: (
        ...args: Parameters<PromptQueuePersistence['enqueuePromptQueueEntry']>
      ) => persistence.enqueuePromptQueueEntry(...args),
      removePromptQueueEntry: (
        ...args: Parameters<PromptQueuePersistence['removePromptQueueEntry']>
      ) => persistence.removePromptQueueEntry(...args),
      reorderPromptQueueEntry: (
        ...args: Parameters<PromptQueuePersistence['reorderPromptQueueEntry']>
      ) => persistence.reorderPromptQueueEntry(...args),
      clearDeliveredPromptQueueEntries: (key: string) =>
        persistence.clearDeliveredPromptQueueEntries(key),
      requeuePromptQueueEntry: (
        ...args: Parameters<PromptQueuePersistence['requeuePromptQueueEntry']>
      ) => persistence.requeuePromptQueueEntry(...args),
      settlePromptQueueEntry: (
        ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
      ) => persistence.settlePromptQueueEntry(...args)
    },
    ...over
  } as unknown as RpcContext
  const method = (name: string): RpcMethod =>
    PROMPT_QUEUE_METHODS.find((entry) => entry.name === name)!
  return {
    ctx,
    state,
    call: (name, params) => {
      const target = method(name)
      const parsed = target.params ? target.params.parse(params) : params
      return target.handler(parsed, ctx) as { queue: PromptQueue; waitReason?: unknown }
    }
  }
}

const enqueue = (call: ReturnType<typeof context>['call'], id: string, text: string): PromptQueue =>
  call(PROMPT_QUEUE_RPC.enqueue, { source, id, text }).queue

describe('promptQueue.*', () => {
  it('queues, lists, reorders, removes and clears — and creates nothing else', () => {
    const { call, state } = context()

    enqueue(call, 'e1', 'Research the code')
    enqueue(call, 'e2', 'Now plan it')
    const queued = enqueue(call, 'e3', 'Have you done your best job?')
    expect(queued.entries.map((entry) => entry.text)).toEqual([
      'Research the code',
      'Now plan it',
      'Have you done your best job?'
    ])

    const moved = call(PROMPT_QUEUE_RPC.reorder, { source, entryId: 'e3', direction: 'up' }).queue
    expect(moved.entries.map((entry) => entry.id)).toEqual(['e1', 'e3', 'e2'])

    const removed = call(PROMPT_QUEUE_RPC.remove, { source, entryId: 'e1' }).queue
    expect(removed.entries.map((entry) => entry.id)).toEqual(['e3', 'e2'])

    expect(call(PROMPT_QUEUE_RPC.list, { source }).queue.entries).toHaveLength(2)

    // The acceptance the frozen model asks for: ordinary conversation creates nothing.
    expect(state.sessionChains).toBeUndefined()
    expect(Object.keys(state.promptQueues ?? {})).toEqual([rowKey])
    expect(
      Object.values(state.promptQueues ?? {}).flatMap((queue) => queue.entries)
    ).not.toContainEqual(expect.objectContaining({ outcomeSet: expect.anything() }))
  })

  it('does not move a prompt past the end of the queue', () => {
    const { call } = context()
    enqueue(call, 'e1', 'first')
    enqueue(call, 'e2', 'second')
    expect(
      call(PROMPT_QUEUE_RPC.reorder, { source, entryId: 'e1', direction: 'up' }).queue.entries.map(
        (entry) => entry.id
      )
    ).toEqual(['e1', 'e2'])
    expect(
      call(PROMPT_QUEUE_RPC.reorder, {
        source,
        entryId: 'e2',
        direction: 'down'
      }).queue.entries.map((entry) => entry.id)
    ).toEqual(['e1', 'e2'])
  })

  it('clears what already settled and keeps what is still waiting', () => {
    const { call, state } = context()
    enqueue(call, 'e1', 'delivered one')
    enqueue(call, 'e2', 'still waiting')
    state.promptQueues![rowKey]!.entries[0] = {
      ...state.promptQueues![rowKey]!.entries[0]!,
      state: 'delivered',
      deliveredAt: 5,
      door: 'pty'
    }
    expect(
      call(PROMPT_QUEUE_RPC.clearDelivered, { source }).queue.entries.map((entry) => entry.id)
    ).toEqual(['e2'])
  })

  it('answers with an empty queue for a conversation that has none', () => {
    const { call } = context()
    expect(call(PROMPT_QUEUE_RPC.list, { source }).queue).toEqual({ source, entries: [] })
  })

  it('refuses an agent: queuing the next message is the person’s decision', () => {
    const { call } = context({ orchestrationCapability: 'cap_1' })
    expect(() => call(PROMPT_QUEUE_RPC.enqueue, { source, id: 'e1', text: 'go' })).toThrow(
      'authenticated user interface'
    )
    expect(() => call(PROMPT_QUEUE_RPC.list, { source })).toThrow('authenticated user interface')
  })

  it('refuses a chat conversation that names no session to send to', () => {
    const { call } = context()
    expect(() =>
      call(PROMPT_QUEUE_RPC.enqueue, {
        source: { ...source, kind: 'structured' },
        id: 'e1',
        text: 'go'
      })
    ).toThrow('cannot be addressed')
  })

  it('refuses an empty prompt at the wire', () => {
    const { call } = context()
    expect(() => call(PROMPT_QUEUE_RPC.enqueue, { source, id: 'e1', text: '' })).toThrow()
  })
})

describe('who may read and who may decide', () => {
  // The local CLI: the Unix-socket dispatch passes no clientId, no clientKind and no
  // pairedDeviceId, which is exactly what this context is.
  const localCli = { clientId: undefined }

  it('lets a local caller with no client identity READ the queue', () => {
    const { call } = context(localCli)

    expect(call(PROMPT_QUEUE_RPC.list, { source }).queue).toEqual({ source, entries: [] })
  })

  it('refuses every DECISION from that same caller — it cannot prove it is the person', () => {
    const { call } = context(localCli)
    for (const attempt of [
      () => call(PROMPT_QUEUE_RPC.enqueue, { source, id: 'e1', text: 'go' }),
      () => call(PROMPT_QUEUE_RPC.remove, { source, entryId: 'e1' }),
      () => call(PROMPT_QUEUE_RPC.reorder, { source, entryId: 'e1', direction: 'up' }),
      () => call(PROMPT_QUEUE_RPC.requeue, { source, entryId: 'e1' }),
      () => call(PROMPT_QUEUE_RPC.clearDelivered, { source })
    ]) {
      expect(attempt).toThrow('authenticated user interface')
    }
  })

  it('refuses even the read for a caller asserting agent authority', () => {
    for (const agent of [
      { orchestrationCapability: 'cap_1' },
      { orchestrationCompatibilityEvidence: { agentSessionId: 'chat_1' } }
    ]) {
      const { call } = context(agent as never)
      expect(() => call(PROMPT_QUEUE_RPC.list, { source })).toThrow('authenticated user interface')
      expect(() => call(PROMPT_QUEUE_RPC.enqueue, { source, id: 'e1', text: 'go' })).toThrow(
        'authenticated user interface'
      )
    }
  })

  it('keeps the person’s own interface able to do both', () => {
    const { call } = context()
    expect(() => enqueue(call, 'e1', 'Research the code')).not.toThrow()
    expect(call(PROMPT_QUEUE_RPC.list, { source }).queue.entries).toHaveLength(1)
  })
})

describe('a queue paused behind a failed prompt', () => {
  const pausedContext = () => {
    const test = context()
    enqueue(test.call, 'e1', 'Research the code')
    enqueue(test.call, 'e2', 'Now plan it')
    ;(test.ctx.runtime as unknown as PromptQueuePersistence).settlePromptQueueEntry(rowKey, 'e1', {
      state: 'failed',
      reason: 'gone'
    })
    return test
  }

  it('answers an unpaused list in exactly the shape an old client reads', () => {
    const { call } = context()
    enqueue(call, 'e1', 'Research the code')
    expect(Object.keys(call(PROMPT_QUEUE_RPC.list, { source }))).toEqual(['queue'])
  })

  it('says why it waits in an optional field beside the queue', () => {
    const { call } = pausedContext()
    const listed = call(PROMPT_QUEUE_RPC.list, { source })
    expect(listed.waitReason).toEqual({ kind: 'paused-after-failure', entryId: 'e1' })
    expect(listed.queue.entries.map((entry) => entry.id)).toEqual(['e1', 'e2'])
  })

  it('queues the failed prompt again at the head, which ends the pause', () => {
    const { call } = pausedContext()
    const queue = call(PROMPT_QUEUE_RPC.requeue, { source, entryId: 'e1' }).queue
    expect(queue.entries.map((entry) => [entry.text, entry.state])).toEqual([
      ['Research the code', 'queued'],
      ['Now plan it', 'queued']
    ])
    expect(queue.entries[0]!.id).not.toBe('e1')
    expect(call(PROMPT_QUEUE_RPC.list, { source }).waitReason).toBeUndefined()
  })

  it('ends the pause when the failed prompt is dismissed', () => {
    const { call } = pausedContext()
    call(PROMPT_QUEUE_RPC.remove, { source, entryId: 'e1' })
    expect(call(PROMPT_QUEUE_RPC.list, { source }).waitReason).toBeUndefined()
  })
})
