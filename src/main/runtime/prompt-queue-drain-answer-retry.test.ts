/**
 * A decision answer (`artifact-review`, `work-delivery`) refused before any byte moved, for a
 * reason that passes on its own, goes back to `queued` and is tried again after a backoff, instead
 * of failing for good. Anything that may have typed text stays final; other writers are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const door = vi.hoisted(() => ({ refuse: null as (() => Error) | null }))
vi.mock('./conversation-delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof ConversationDelivery>()
  return {
    ...actual,
    deliverToConversation: async (...args: Parameters<typeof actual.deliverToConversation>) => {
      if (door.refuse) {
        throw door.refuse()
      }
      return await actual.deliverToConversation(...args)
    }
  }
})

import type * as ConversationDelivery from './conversation-delivery'
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { GUARDED_WRITE_FENCE_REVOKED } from '../pty/guarded-pty-write'
import { SessionHostDeliveryRefusedError } from '../session-host/session-host-delivery-admission'
import { ConversationNotSentError } from './conversation-delivery-not-sent'
import { drainPromptQueues } from './prompt-queue-drain'
import { PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS } from './prompt-queue-answer-retry'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  bindSessionPrompt,
  releaseSessionPrompt,
  sessionPromptBinding
} from './session-prompt-binding'

const SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const ROW = conversationSourceRowKey(SOURCE)
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
const T0 = Date.parse('2026-10-11T22:00:00Z')

function harness() {
  const state = { promptQueues: {} } as unknown as PersistedState
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const writes: string[] = []
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
    assertTerminalAgentProcess: async () => {},
    sendTerminalAgentPrompt: async (handle: string, text: string) => {
      writes.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  const queue = (actor = 'artifact-review', retry?: PromptQueueEntry['retry']) => {
    persistence.enqueuePromptQueueEntry(SOURCE, {
      id: ID,
      text: '[OmniOS decision] Approved.',
      createdAt: T0,
      state: 'queued',
      requestedBy: { action: 'continue', actor },
      ...(retry ? { retry } : {})
    })
    bindSessionPrompt(ROW, ID, { receiver: PROOF })
  }
  const entry = () => persistence.readPromptQueue(ROW)!.entries.find((row) => row.id === ID)!
  const drain = () => drainPromptQueues(runtime, { epoch: 'epoch-1' })
  return { queue, entry, drain, writes }
}

const turnReserved = () =>
  new SessionHostDeliveryRefusedError(
    sessionHostRefusal('turn-reserved', 'Another request already holds this turn.')
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  door.refuse = null
  releaseSessionPrompt(ROW, ID)
  vi.useRealTimers()
})

describe('a decision answer refused before any byte moved', () => {
  it('waits out its backoff while another write holds the turn, then goes once', async () => {
    const test = harness()
    test.queue()
    door.refuse = turnReserved
    await test.drain()
    expect(test.entry()).toMatchObject({
      state: 'queued',
      retry: { attempts: 1, firstAt: T0, notBefore: T0 + 15_000 }
    })
    expect(test.entry().operationId).toBeUndefined()
    expect(sessionPromptBinding(ROW, ID)).not.toBeNull()

    door.refuse = null
    vi.setSystemTime(T0 + 10_000)
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry().state).toBe('queued')

    vi.setSystemTime(T0 + 15_000)
    await test.drain()
    expect(test.writes).toEqual(['[OmniOS decision] Approved.'])
    expect(test.entry().state).toBe('delivered')
    expect(sessionPromptBinding(ROW, ID)).toBeNull()
  })

  it('backs off further on each refusal', async () => {
    const test = harness()
    test.queue()
    door.refuse = turnReserved
    await test.drain()
    vi.setSystemTime(T0 + 15_000)
    await test.drain()
    expect(test.entry().retry).toMatchObject({ attempts: 2, notBefore: T0 + 45_000 })
  })

  it('goes again when its write fence was revoked before the first byte', async () => {
    const test = harness()
    test.queue('work-delivery')
    door.refuse = () => new ConversationNotSentError(new Error(GUARDED_WRITE_FENCE_REVOKED))
    await test.drain()
    expect(test.entry()).toMatchObject({ state: 'queued', retry: { attempts: 1 } })
  })

  it('stays final when bytes may have landed, so it is never typed twice', async () => {
    const test = harness()
    test.queue()
    door.refuse = () => new Error(`${GUARDED_WRITE_FENCE_REVOKED} Unsent text left in input box.`)
    await test.drain()
    expect(test.entry()).toMatchObject({ state: 'failed' })
    expect(test.entry().unsent).toBeUndefined()
    expect(test.entry().retry).toBeUndefined()
  })

  it('fails unsent once a day of refusals has passed, so its writer decides again', async () => {
    const test = harness()
    vi.setSystemTime(T0 + PROMPT_QUEUE_ANSWER_RETRY_WINDOW_MS)
    test.queue('artifact-review', { attempts: 40, firstAt: T0, notBefore: T0 })
    door.refuse = turnReserved
    await test.drain()
    expect(test.entry()).toMatchObject({ state: 'failed', unsent: true })
    expect(sessionPromptBinding(ROW, ID)).toBeNull()
  })

  it('leaves another session’s prompt as it was: failed unsent, not retried', async () => {
    const test = harness()
    test.queue('tab-9:leaf-1')
    door.refuse = turnReserved
    await test.drain()
    expect(test.entry()).toMatchObject({ state: 'failed', unsent: true })
    expect(test.entry().retry).toBeUndefined()
  })
})
