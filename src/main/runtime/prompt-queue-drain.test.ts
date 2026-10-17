/**
 * The one rule, driven end to end: a queued prompt leaves only when the conversation
 * has finished its turn AND no live plan is bound to it.
 *
 * The persistence is the REAL store domain, so "the receipt is on disk before the
 * bytes move" is observed rather than asserted: the fake flush records the order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import {
  drainPromptQueues,
  PROMPT_QUEUE_DELIVERY_SETTLE_MS,
  PROMPT_QUEUE_UNCONFIRMED_DELIVERY
} from './prompt-queue-drain'
import type { OrcaRuntimeService } from './omni-runtime'
import type { NextStepKeepGoingController } from '../next-steps/next-step-keep-going'
import { setNextStepKeepGoingController } from '../next-steps/next-step-suggestion-slot'

const PTY_SOURCE: ConversationSource = {
  worktreeId: 'wt',
  paneKey: 'tab-1:leaf-1',
  kind: 'pty'
}
const PTY_ROW = conversationSourceRowKey(PTY_SOURCE)
const CHAT_SESSION = 'chat-1'
const CHAT_SOURCE: ConversationSource = {
  worktreeId: 'wt',
  paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(CHAT_SESSION), CHAT_SESSION),
  kind: 'structured',
  sessionId: CHAT_SESSION
}
const CHAT_ROW = conversationSourceRowKey(CHAT_SOURCE)

const DONE_HOOK = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }

type Harness = {
  runtime: OrcaRuntimeService
  state: PersistedState
  persistence: PromptQueuePersistence
  journal: string[]
  prompts: { handle: string; text: string; clientMessageId?: string }[]
  structuredSends: { sessionId: string; clientOperationId: string; text: string }[]
}

function harness(
  options: {
    hook?: Record<string, unknown> | 'lost'
    chains?: SessionChain[]
    promptFails?: string
  } = {}
): Harness {
  const state = { promptQueues: {} } as unknown as PersistedState
  const journal: string[] = []
  const persistence = new PromptQueuePersistence(
    {
      state,
      flushOrThrow: () => {
        journal.push('flush')
      },
      writesFrozen: false
    },
    {} as WriteSchedulingOperations
  )
  const prompts: Harness['prompts'] = []
  const structuredSends: Harness['structuredSends'] = []
  const runtime = {
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (rowKey: string) => persistence.readPromptQueue(rowKey),
    markPromptQueueEntrySendingAndFlush: (
      rowKey: string,
      entryId: string,
      delivery: { operationId: string; deliveryEpoch: string }
    ) => persistence.markPromptQueueEntrySendingAndFlush(rowKey, entryId, delivery),
    settlePromptQueueEntry: (
      rowKey: string,
      entryId: string,
      settlement: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>[2]
    ) => persistence.settlePromptQueueEntry(rowKey, entryId, settlement),
    listSessionChains: () => options.chains ?? [],
    resolveTerminalPane: () => {
      // A hook object carrying `lost` drops contact mid-test.
      if (options.hook === 'lost' || options.hook?.lost) {
        throw new Error('terminal_not_found')
      }
      return { handle: 'h', worktreeId: 'wt' }
    },
    getFreshAgentHookStatusForHandle: () =>
      options.hook === 'lost' ? null : (options.hook ?? DONE_HOOK),
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    sendTerminalAgentPrompt: async (
      handle: string,
      text: string,
      opts?: { clientMessageId?: string }
    ) => {
      journal.push('write')
      if (options.promptFails) {
        throw new Error(options.promptFails)
      }
      prompts.push({
        handle,
        text,
        ...(opts?.clientMessageId ? { clientMessageId: opts.clientMessageId } : {})
      })
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  return { runtime, state, persistence, journal, prompts, structuredSends }
}

function queueOne(test: Harness, source: ConversationSource, text: string, id = 'e1'): void {
  test.persistence.enqueuePromptQueueEntry(source, {
    id,
    text,
    createdAt: Date.now(),
    state: 'queued'
  })
}

function read(test: Harness, rowKey = PTY_ROW): PromptQueue | null {
  return test.persistence.readPromptQueue(rowKey)
}

function installChatHost(
  test: Harness,
  options: {
    turn?: Record<string, unknown> | null
    fence?: number | null
    refusal?: string
  } = {}
): void {
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId: CHAT_SESSION, workspaceId: 'wt', agent: 'claude' }],
    turnState: () =>
      options.turn === undefined
        ? { running: false, hasTurn: true, outcome: 'completed', lastSequence: 4 }
        : options.turn,
    deps: {
      store: {
        getRecord: () =>
          options.fence === null
            ? null
            : { sessionId: CHAT_SESSION, lease: { runtimeFence: options.fence ?? 7 } }
      }
    },
    send: async (
      _caller: unknown,
      params: {
        envelope: { sessionId: string; clientOperationId: string }
        body: { blocks: { text: string }[] }
      }
    ) => {
      test.journal.push('write')
      if (options.refusal) {
        return {
          ok: false,
          refusal: { code: 'agent_session_operation_invalid', message: options.refusal }
        }
      }
      test.structuredSends.push({
        sessionId: params.envelope.sessionId,
        clientOperationId: params.envelope.clientOperationId,
        text: params.body.blocks.map((block) => block.text).join('')
      })
      return {
        ok: true,
        replayed: false,
        fence: 7,
        cursor: { epoch: 'e', sequence: 1 },
        value: { submission: { dispatchState: 'accepted' } }
      }
    }
  } as never)
}

const chain = (over: Partial<SessionChain> = {}): SessionChain =>
  ({
    id: 'source_1',
    sourcePaneKey: PTY_SOURCE.paneKey,
    worktreeId: 'wt',
    sourceRowKey: PTY_ROW,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    ...over
  }) as unknown as SessionChain

const outcomeSet = (satisfied: boolean) => ({
  revision: 1,
  outcomes: [
    {
      id: 'o1',
      title: 'Ship it',
      status: satisfied ? 'satisfied' : 'active',
      revision: 1,
      conditions: [],
      evidence: []
    }
  ],
  attempts: [],
  evidenceHistory: [],
  continuation: { owner: 'execution-host', state: 'owned', epoch: 'x' }
})

beforeEach(() => vi.useRealTimers())
afterEach(() => setStructuredAgentSessionHost(null))

describe('a queued prompt on an idle conversation', () => {
  it('is delivered exactly once, through the terminal door, with its own operation id', async () => {
    const test = harness()
    queueOne(test, PTY_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toEqual([
      {
        handle: 'h',
        text: 'Have you done your best job?',
        clientMessageId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/)
      }
    ])
    const entry = read(test)!.entries[0]!
    expect(entry).toMatchObject({ state: 'delivered', door: 'pty', deliveryEpoch: 'epoch-1' })
    expect(entry.deliveredAt).toBeGreaterThan(0)

    // A second tick finds nothing left to send.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(1)
  })

  it('writes the receipt to disk BEFORE the bytes move', async () => {
    const test = harness()
    queueOne(test, PTY_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.journal).toEqual(['flush', 'write'])
  })

  it('delivers the queue in the order it was written, one per finished turn', async () => {
    const hook: Record<string, unknown> = { ...DONE_HOOK }
    const test = harness({ hook })
    queueOne(test, PTY_SOURCE, 'Research the code', 'e1')
    queueOne(test, PTY_SOURCE, 'Now plan it', 'e2')
    queueOne(test, PTY_SOURCE, 'Have you done your best job?', 'e3')

    for (let turn = 1; turn <= 3; turn += 1) {
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      Object.assign(hook, { stateStartedAt: 10 + turn, lastAssistantMessage: `Reply ${turn}` })
    }

    expect(test.prompts.map((prompt) => prompt.text)).toEqual([
      'Research the code',
      'Now plan it',
      'Have you done your best job?'
    ])
  })
})

describe('the entry after a delivery on an idle pane', () => {
  // The pane still reads free right after the bytes go, before the agent reports it is working.
  const queueThree = (test: Harness): void => {
    queueOne(test, PTY_SOURCE, 'First', 'e1')
    queueOne(test, PTY_SOURCE, 'Second', 'e2')
    queueOne(test, PTY_SOURCE, 'Third', 'e3')
  }

  it('waits until the agent has worked on the first and finished', async () => {
    const hook: Record<string, unknown> = { ...DONE_HOOK }
    const test = harness({ hook })
    queueThree(test)

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    // Stale `done` from the turn before the delivery: nothing more may move.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First'])

    Object.assign(hook, { state: 'working', stateStartedAt: 20 })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(1)

    Object.assign(hook, { state: 'done', stateStartedAt: 30, lastAssistantMessage: 'Did one.' })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First', 'Second'])
    expect(read(test)!.entries.map((entry) => entry.state)).toEqual([
      'delivered',
      'delivered',
      'queued'
    ])
  })

  it('moves on when a different turn finished between two ticks, even unseen as busy', async () => {
    const hook: Record<string, unknown> = { ...DONE_HOOK }
    const test = harness({ hook })
    queueThree(test)

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    Object.assign(hook, { stateStartedAt: 40, lastAssistantMessage: 'Quick answer.' })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First', 'Second'])
  })

  it('keeps holding when contact is lost and then the same turn reads free again', async () => {
    const hook: Record<string, unknown> = { ...DONE_HOOK }
    const test = harness({ hook })
    queueThree(test)

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    hook.lost = true
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    delete hook.lost
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First'])
  })

  it('keeps holding when a later free reading carries no turn identity, until the fallback', async () => {
    const hook: Record<string, unknown> = { ...DONE_HOOK }
    const test = harness({ hook })
    queueThree(test)
    const start = Date.now()
    vi.useFakeTimers({ now: start })

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    hook.sessionBoundary = true
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First'])

    vi.setSystemTime(start + PROMPT_QUEUE_DELIVERY_SETTLE_MS)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First', 'Second'])
  })

  it('stops holding a pane that never shows the delivery was taken up', async () => {
    const test = harness({ hook: { ...DONE_HOOK } })
    queueThree(test)
    const start = Date.now()
    vi.useFakeTimers({ now: start })

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    vi.setSystemTime(start + PROMPT_QUEUE_DELIVERY_SETTLE_MS - 1)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(1)

    vi.setSystemTime(start + PROMPT_QUEUE_DELIVERY_SETTLE_MS)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['First', 'Second'])
  })
})

describe('a conversation that is not free', () => {
  const busy: {
    name: string
    hook?: Record<string, unknown> | 'lost'
    turn?: Record<string, unknown> | null
  }[] = [
    { name: 'the agent is still working', hook: { state: 'working' } },
    {
      name: 'the agent is waiting for the person',
      hook: { state: 'waiting', interactivePrompt: 'Allow this edit?' }
    },
    { name: 'the agent is blocked', hook: { state: 'blocked' } },
    { name: 'the turn ended in an interrupt', hook: { ...DONE_HOOK, interrupted: true } },
    { name: 'the turn ended in a failure', hook: { ...DONE_HOOK, failed: true } },
    {
      name: 'the turn ended on a pending prompt',
      hook: { ...DONE_HOOK, interactivePrompt: 'Continue?' }
    },
    { name: 'no reading can be made at all', hook: 'lost' }
  ]

  it.each(busy)('holds the prompt when $name', async (row) => {
    const test = harness({ hook: row.hook })
    queueOne(test, PTY_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(0)
    expect(test.journal).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({ state: 'queued' })
  })

  const chatBusy = [
    {
      name: 'the chat turn is still running',
      turn: { running: true, hasTurn: true, lastSequence: 4 }
    },
    {
      name: 'the chat turn was interrupted',
      turn: { running: false, hasTurn: true, outcome: 'interrupted', lastSequence: 4 }
    },
    {
      name: 'the chat turn failed',
      turn: { running: false, hasTurn: true, outcome: 'failed', lastSequence: 4 }
    },
    {
      name: 'the chat turn never recorded how it ended',
      turn: { running: false, hasTurn: true, outcome: 'unknown', lastSequence: 4 }
    }
  ]

  it.each(chatBusy)('holds the prompt when $name', async (row) => {
    const test = harness()
    installChatHost(test, { turn: row.turn })
    queueOne(test, CHAT_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.structuredSends).toHaveLength(0)
    expect(read(test, CHAT_ROW)!.entries[0]).toMatchObject({ state: 'queued' })
  })
})

describe('a conversation that has not finished a turn, but is not running one either', () => {
  /*
   * These two used to sit in the table above, as "not free". They are the round-4 live defect:
   * a brand-new Claude Code pane reports its SessionStart boundary and nothing else, so the
   * queue read it as busy and a typed `/next` waited ~95 s for a turn that would not otherwise
   * have happened (`evidence/na-live-phase1-20260918T063329Z` cli/10k, 10o, 13d). A boundary is
   * the agent sitting at its own prompt: there is no finished turn to build on — which is the
   * CHAIN's question, and still answered `ready: false` — and nothing in flight to wait for.
   */
  it('delivers on a fresh pane whose only reading is its session boundary', async () => {
    const test = harness({ hook: { ...DONE_HOOK, sessionBoundary: true } })
    queueOne(test, PTY_SOURCE, 'Reply with exactly the word FIRST and nothing else.')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toMatchObject([
      { handle: 'h', text: 'Reply with exactly the word FIRST and nothing else.' }
    ])
    expect(read(test)!.entries[0]).toMatchObject({ state: 'delivered', door: 'pty' })
  })

  it('delivers on a chat session that has taken no turn yet', async () => {
    const test = harness()
    installChatHost(test, { turn: { running: false, hasTurn: false, lastSequence: 0 } })
    queueOne(test, CHAT_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.structuredSends).toMatchObject([{ text: 'Have you done your best job?' }])
    expect(read(test, CHAT_ROW)!.entries[0]).toMatchObject({ state: 'delivered' })
  })

  it('still holds while the agent is asking the person something at that boundary', async () => {
    const test = harness({
      hook: { ...DONE_HOOK, sessionBoundary: true, interactivePrompt: 'Allow this edit?' }
    })
    queueOne(test, PTY_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(0)
    expect(read(test)!.entries[0]).toMatchObject({ state: 'queued' })
  })
})

describe('a live plan owns the conversation', () => {
  it('holds the prompt while an outcome set on this conversation is unfinished', async () => {
    const test = harness({ chains: [chain({ outcomeSet: outcomeSet(false) as never })] })
    queueOne(test, PTY_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(0)
    expect(read(test)!.entries[0]).toMatchObject({ state: 'queued' })
  })

  it('holds the prompt while a plain plan still has steps to run', async () => {
    const test = harness({
      chains: [chain({ steps: [{ id: 's1' } as never], currentIndex: 0, state: 'waiting' })]
    })
    queueOne(test, PTY_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(0)
  })

  it('sends once that plan has finished', async () => {
    const test = harness({
      chains: [chain({ outcomeSet: outcomeSet(true) as never, state: 'done' })]
    })
    queueOne(test, PTY_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(1)
  })

  it('ignores a plan bound to a different conversation', async () => {
    const test = harness({ chains: [chain({ sourcePaneKey: 'tab-9:leaf-9' })] })
    queueOne(test, PTY_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(1)
  })
})

describe('the chat door', () => {
  it('sends the person’s own text with a fresh operation id and the current fence', async () => {
    const test = harness()
    installChatHost(test)
    queueOne(test, CHAT_SOURCE, 'Have you done your best job?')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.structuredSends).toEqual([
      {
        sessionId: CHAT_SESSION,
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        text: 'Have you done your best job?'
      }
    ])
    expect(read(test, CHAT_ROW)!.entries[0]).toMatchObject({
      state: 'delivered',
      door: 'structured'
    })
  })

  it('records the host’s own words when the send is refused', async () => {
    const test = harness()
    installChatHost(test, { refusal: 'Wait for the conversation operation to finish.' })
    queueOne(test, CHAT_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(read(test, CHAT_ROW)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: 'Wait for the conversation operation to finish.'
    })
  })

  it('fails the entry when the chat session is gone', async () => {
    const test = harness()
    installChatHost(test, { fence: null })
    queueOne(test, CHAT_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(read(test, CHAT_ROW)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: 'This chat conversation is no longer open.'
    })
  })
})

describe('a delivery that cannot be completed', () => {
  it('fails the entry with the reason when the pane goes between the reading and the write', async () => {
    const test = harness({ promptFails: 'terminal_not_writable' })
    queueOne(test, PTY_SOURCE, 'Continue')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: 'terminal_not_writable'
    })
    // Nothing retries it (the pause behind it is covered in prompt-queue-drain-pause.test.ts).
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(0)
  })

  it('never re-sends a delivery a previous process started', async () => {
    const test = harness()
    queueOne(test, PTY_SOURCE, 'Have you done your best job?', 'e1')
    queueOne(test, PTY_SOURCE, 'Continue', 'e2')
    // The delivery was admitted and the receipt flushed; the process then died.
    test.persistence.markPromptQueueEntrySendingAndFlush(PTY_ROW, 'e1', {
      operationId: 'prompt-queue:old',
      deliveryEpoch: 'epoch-before-the-restart'
    })
    test.journal.length = 0

    await drainPromptQueues(test.runtime, { epoch: 'epoch-after-the-restart' })

    expect(test.prompts).toHaveLength(0)
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_UNCONFIRMED_DELIVERY
    })

    // The rest of the queue waits for the person, then moves on in order.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-after-the-restart' })
    expect(test.prompts).toHaveLength(0)
    test.persistence.removePromptQueueEntry(PTY_ROW, 'e1')
    await drainPromptQueues(test.runtime, { epoch: 'epoch-after-the-restart' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['Continue'])
  })
})

describe('a queue that changes while the drain reads the conversation', () => {
  const duringFirstReading = (test: Harness, change: () => void): void => {
    const observe = test.runtime.getFreshAgentHookStatusForHandle.bind(test.runtime)
    let changed = false
    Object.assign(test.runtime, {
      getFreshAgentHookStatusForHandle: (...args: unknown[]) => {
        if (!changed) {
          changed = true
          change()
        }
        return (observe as (...rest: unknown[]) => unknown)(...args)
      }
    })
  }

  it('sends the entry the person moved to the front, not the one it read first', async () => {
    const test = harness()
    queueOne(test, PTY_SOURCE, 'First', 'e1')
    queueOne(test, PTY_SOURCE, 'Actually this first', 'e2')
    duringFirstReading(test, () => test.persistence.reorderPromptQueueEntry(PTY_ROW, 'e2', 'up'))

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toEqual([])
    expect(read(test)!.entries.map((entry) => entry.state)).toEqual(['queued', 'queued'])

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['Actually this first'])
  })

  it('never sends beside a prompt another sender admitted in the meantime', async () => {
    const test = harness()
    queueOne(test, PTY_SOURCE, 'Queued', 'e1')
    queueOne(test, PTY_SOURCE, 'Sent now', 'e2')
    duringFirstReading(test, () =>
      test.persistence.markPromptQueueEntrySendingAndFlush(PTY_ROW, 'e2', {
        operationId: 'up-next:now',
        deliveryEpoch: 'epoch-1'
      })
    )

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toEqual([])
    expect(read(test)!.entries.map((entry) => entry.state)).toEqual(['queued', 'sending'])
  })
})

describe('three prompts queued while the agent works', () => {
  it('sends them in order, one per idle window, and never twice after a restart', async () => {
    // The same hook object the readiness observer reads, moved from working to done
    // between the host's ticks — the transition a person actually waits through.
    const hook: Record<string, unknown> = { state: 'working', stateStartedAt: 10 }
    const test = harness({ hook })
    queueOne(test, PTY_SOURCE, 'Research the code', 'e1')
    queueOne(test, PTY_SOURCE, 'Now plan it', 'e2')
    queueOne(test, PTY_SOURCE, 'is there anything else we can do to improve?', 'e3')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(0)
    expect(test.journal).toEqual([])

    Object.assign(hook, DONE_HOOK)
    for (let turn = 1; turn <= 3; turn += 1) {
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      // The agent takes the prompt up, then finishes it.
      Object.assign(hook, { state: 'working', stateStartedAt: 10 + turn })
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      Object.assign(hook, { ...DONE_HOOK, stateStartedAt: 10 + turn })
    }

    expect(test.prompts.map((prompt) => prompt.text)).toEqual([
      'Research the code',
      'Now plan it',
      'is there anything else we can do to improve?'
    ])
    // The PTY door the person's own composer uses — host prompt submission, which
    // owns the busy-agent Enter delay — reached once per prompt with its own id.
    expect(test.prompts.every((prompt) => prompt.handle === 'h')).toBe(true)
    expect(new Set(test.prompts.map((prompt) => prompt.clientMessageId)).size).toBe(3)
    // Every write is preceded by its own flushed receipt.
    expect(test.journal).toEqual(['flush', 'write', 'flush', 'write', 'flush', 'write'])
    const entries = read(test)!.entries
    expect(entries.map((entry) => entry.operationId)).toEqual(
      test.prompts.map((prompt) => prompt.clientMessageId)
    )
    expect(entries.every((entry) => entry.state === 'delivered' && entry.door === 'pty')).toBe(true)

    // A restart re-ticks the same persisted queue under a new epoch: nothing moves.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-2' })
    expect(test.prompts).toHaveLength(3)
    expect(test.journal.filter((event) => event === 'write')).toHaveLength(3)
  })
})

describe('an automatic Keep going prompt', () => {
  const origin = { kind: 'keep-going' as const, runToken: 'run001', round: 1 }
  const queueAuto = (test: Harness) =>
    test.persistence.enqueuePromptQueueEntry(PTY_SOURCE, {
      id: 'next-step:set-1:s1',
      text: '[Keep going 1/3 · kg-abc123] Add a regression test.',
      createdAt: Date.now(),
      state: 'queued',
      origin
    })
  /** The terminal door runs its write-time check, as the real submission does. */
  const withWriteTimeCheck = (test: Harness, beforeCheck: () => void = () => {}) => {
    const send = test.runtime.sendTerminalAgentPrompt.bind(test.runtime)
    Object.assign(test.runtime, {
      sendTerminalAgentPrompt: async (
        handle: string,
        text: string,
        opts: { clientMessageId?: string; beforeWrite?: (ptyId: string) => void | Promise<void> }
      ) => {
        beforeCheck()
        await opts.beforeWrite?.('pty-1')
        return send(handle, text, opts)
      }
    })
  }
  afterEach(() => setNextStepKeepGoingController(null))

  it('keeps its provenance in the queue', () => {
    const test = harness()
    queueAuto(test)
    expect(read(test)!.entries[0]!.origin).toEqual(origin)
  })

  it('is never sent after a restart: no Keep going on this host means it fails unsent', async () => {
    const test = harness()
    queueAuto(test)
    withWriteTimeCheck(test)

    await drainPromptQueues(test.runtime, { epoch: 'epoch-2' })

    expect(test.prompts).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({ state: 'failed' })
  })

  it('is never written when the person queues their own message while the drain awaits', async () => {
    const test = harness()
    queueAuto(test)
    const assertDelivery = vi.fn((_source: ConversationSource, entry: { id: string }) => {
      const foreign = read(test)!.entries.some(
        (candidate) =>
          candidate.id !== entry.id &&
          (candidate.state === 'queued' || candidate.state === 'sending')
      )
      if (foreign) {
        throw new Error('Keep going stopped before this was sent (person-message).')
      }
    })
    setNextStepKeepGoingController({ assertDelivery } as unknown as NextStepKeepGoingController)
    withWriteTimeCheck(test, () => queueOne(test, PTY_SOURCE, 'My own message', 'mine'))

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toEqual([])
    expect(assertDelivery).toHaveBeenCalledTimes(2)
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: 'Keep going stopped before this was sent (person-message).'
    })
  })

  it('goes out when its round is still wanted at write time', async () => {
    const test = harness()
    queueAuto(test)
    const onDelivered = vi.fn()
    setNextStepKeepGoingController({
      assertDelivery: vi.fn(),
      onDelivered
    } as unknown as NextStepKeepGoingController)
    withWriteTimeCheck(test)

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toHaveLength(1)
    // The round is counted at delivery, not when the decision log finishes.
    expect(onDelivered).toHaveBeenCalledWith(PTY_SOURCE, 'next-step:set-1:s1')
    expect(read(test)!.entries[0]).toMatchObject({ state: 'delivered' })
  })
})
