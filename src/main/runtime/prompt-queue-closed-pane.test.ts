/**
 * A decision or review answer queued to a pane that was then closed settles failed and unsent once
 * the pane reads gone on two drains a minute apart, so its writer can deliver it another way. A
 * busy or unreadable pane, a pane gone only once, the person's own prompt and other writers wait
 * exactly as before. An answer whose retry day ran out on a pane that never read free also ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { drainPromptQueues } from './prompt-queue-drain'
import { PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS } from './prompt-queue-answer-retry'
import {
  PROMPT_QUEUE_ANSWER_RETRY_EXPIRED,
  PROMPT_QUEUE_PANE_CLOSED,
  PROMPT_QUEUE_PANE_CLOSED_CONFIRM_MS
} from './prompt-queue-closed-pane'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  bindSessionPrompt,
  releaseSessionPrompt,
  sessionPromptBinding
} from './session-prompt-binding'

const ID = 'artifact-review:1'
const PROOF = {
  ptyId: 'pty-1',
  incarnationId: null,
  rootPid: 100,
  pid: 200,
  pgid: 200,
  startTimeMs: 1,
  agent: 'claude',
  via: 'command-line' as const
}
const T0 = Date.parse('2026-10-12T10:00:00Z')
const CONFIRM = PROMPT_QUEUE_PANE_CLOSED_CONFIRM_MS

type Pane = 'free' | 'busy' | 'unreadable'
let paneCounter = 0
const rows: string[] = []

/** `pane` is how the session reads; `closed` is whether this computer has lost the pane. */
function harness(pane: Pane, closed: { value: boolean | 'throws' }) {
  // Why a fresh pane per test: the first-seen-closed sighting is kept per row in memory.
  paneCounter += 1
  const source: ConversationSource = {
    worktreeId: 'wt',
    paneKey: `tab-${paneCounter}:leaf-1`,
    kind: 'pty'
  }
  const row = conversationSourceRowKey(source)
  rows.push(row)
  const state = { promptQueues: {} } as unknown as PersistedState
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const writes: string[] = []
  const closedChecks: [string, string][] = []
  const runtime = {
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (rowKey: string) => persistence.readPromptQueue(rowKey),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => persistence.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => persistence.settlePromptQueueEntry(...args),
    retryPromptQueueEntryLater: (
      ...args: Parameters<PromptQueuePersistence['retryPromptQueueEntryLater']>
    ) => persistence.retryPromptQueueEntryLater(...args),
    isTerminalPaneClosedHere: (paneKey: string, worktreeId: string) => {
      closedChecks.push([paneKey, worktreeId])
      if (closed.value === 'throws') {
        throw new Error('session store unreadable')
      }
      return closed.value
    },
    listSessionChains: () => [],
    resolveTerminalPane: () => {
      if (pane === 'unreadable') {
        throw new Error('Terminal pane not found')
      }
      return { handle: 'h', worktreeId: 'wt' }
    },
    getFreshAgentHookStatusForHandle: () =>
      pane === 'busy'
        ? { state: 'working', stateStartedAt: 10 }
        : { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' },
    getTerminalPaneKey: () => source.paneKey,
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    assertTerminalAgentProcess: async () => {},
    sendTerminalAgentPrompt: async (handle: string, text: string) => {
      writes.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  const queue = (
    requestedBy: PromptQueueEntry['requestedBy'] | null = {
      action: 'continue',
      actor: 'artifact-review'
    },
    extra: Partial<PromptQueueEntry> = {}
  ) => {
    persistence.enqueuePromptQueueEntry(source, {
      id: ID,
      text: '[OmniOS decision] Approved.',
      createdAt: T0,
      state: 'queued',
      ...(requestedBy ? { requestedBy } : {}),
      ...extra
    })
    if (requestedBy) {
      bindSessionPrompt(row, ID, { receiver: PROOF })
    }
  }
  const entry = () => persistence.readPromptQueue(row)!.entries.find((item) => item.id === ID)!
  const drainAt = async (at: number) => {
    vi.setSystemTime(at)
    await drainPromptQueues(runtime, { epoch: 'epoch-1' })
  }
  return { row, source, persistence, queue, entry, drainAt, writes, closedChecks }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  for (const row of rows.splice(0)) {
    releaseSessionPrompt(row, ID)
  }
  vi.useRealTimers()
})

describe('an answer queued to a closed pane', () => {
  it('settles failed and unsent once the pane reads gone a minute apart', async () => {
    const test = harness('unreadable', { value: true })
    test.queue()
    await test.drainAt(T0)
    await test.drainAt(T0 + CONFIRM / 2)
    expect(test.entry().state).toBe('queued')

    await test.drainAt(T0 + CONFIRM)
    expect(test.entry()).toMatchObject({
      state: 'failed',
      unsent: true,
      reason: PROMPT_QUEUE_PANE_CLOSED
    })
    expect(test.writes).toEqual([])
    expect(sessionPromptBinding(test.row, ID)).toBeNull()
    expect(test.closedChecks[0]).toEqual([test.source.paneKey, 'wt'])
  })

  it('settles a work-delivery answer the same way', async () => {
    const test = harness('unreadable', { value: true })
    test.queue({ action: 'continue', actor: 'work-delivery' })
    await test.drainAt(T0)
    await test.drainAt(T0 + CONFIRM)
    expect(test.entry()).toMatchObject({ state: 'failed', unsent: true })
  })

  it('still settles while the answer waits out a retry backoff', async () => {
    const test = harness('unreadable', { value: true })
    test.queue(undefined, {
      retry: { attempts: 1, firstAt: T0, notBefore: T0 + 10 * CONFIRM }
    })
    await test.drainAt(T0)
    await test.drainAt(T0 + CONFIRM)
    expect(test.entry()).toMatchObject({ state: 'failed', unsent: true })
  })

  it('waits again from the start when the pane comes back in between', async () => {
    const closed = { value: true as boolean | 'throws' }
    const test = harness('unreadable', closed)
    test.queue()
    await test.drainAt(T0)
    closed.value = false
    await test.drainAt(T0 + CONFIRM / 2)
    closed.value = true
    await test.drainAt(T0 + CONFIRM + 1)
    expect(test.entry().state).toBe('queued')

    await test.drainAt(T0 + 2 * CONFIRM + 1)
    expect(test.entry()).toMatchObject({ state: 'failed', unsent: true })
  })
})

describe('what stays exactly as it was', () => {
  it('a pane read gone only once', async () => {
    const test = harness('unreadable', { value: true })
    test.queue()
    await test.drainAt(T0)
    expect(test.entry().state).toBe('queued')
    expect(sessionPromptBinding(test.row, ID)).not.toBeNull()
  })

  it('a pane not restored yet, or whose saved session cannot be read', async () => {
    for (const value of [false, 'throws'] as const) {
      const test = harness('unreadable', { value })
      test.queue()
      await test.drainAt(T0)
      await test.drainAt(T0 + 2 * CONFIRM)
      expect(test.entry().state).toBe('queued')
    }
  })

  it('a busy pane', async () => {
    const test = harness('busy', { value: false })
    test.queue()
    await test.drainAt(T0)
    await test.drainAt(T0 + 2 * CONFIRM)
    expect(test.entry().state).toBe('queued')
    expect(test.writes).toEqual([])
  })

  it('an unverifiable pane this computer still has', async () => {
    const test = harness('unreadable', { value: false })
    test.queue()
    await test.drainAt(T0)
    await test.drainAt(T0 + 2 * CONFIRM)
    expect(test.entry().state).toBe('queued')
  })

  it("the person's own prompt, even on a closed pane", async () => {
    const test = harness('unreadable', { value: true })
    test.queue(null)
    await test.drainAt(T0)
    await test.drainAt(T0 + 2 * CONFIRM)
    expect(test.entry().state).toBe('queued')
    expect(test.entry().unsent).toBeUndefined()
  })

  it('a relay from another session, even on a closed pane', async () => {
    const test = harness('unreadable', { value: true })
    test.queue({ action: 'continue', actor: 'tab-9:leaf-1' })
    await test.drainAt(T0)
    await test.drainAt(T0 + 2 * CONFIRM)
    expect(test.entry().state).toBe('queued')
  })

  it('an answer already sending in this run', async () => {
    const test = harness('unreadable', { value: true })
    test.queue()
    test.persistence.markPromptQueueEntrySendingAndFlush(test.row, ID, {
      operationId: 'op-1',
      deliveryEpoch: 'epoch-1'
    })
    await test.drainAt(T0)
    await test.drainAt(T0 + 2 * CONFIRM)
    expect(test.entry().state).toBe('sending')
  })
})

describe('an answer whose retry day ran out on a pane that never read free', () => {
  it('settles failed and unsent', async () => {
    const test = harness('busy', { value: false })
    test.queue(undefined, {
      retry: { attempts: 3, firstAt: T0, notBefore: T0 + CONFIRM }
    })
    await test.drainAt(T0 + PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS - 1)
    expect(test.entry().state).toBe('queued')

    await test.drainAt(T0 + PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS)
    expect(test.entry()).toMatchObject({
      state: 'failed',
      unsent: true,
      reason: PROMPT_QUEUE_ANSWER_RETRY_EXPIRED
    })
    expect(test.writes).toEqual([])
  })
})
