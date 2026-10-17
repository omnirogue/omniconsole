/**
 * A prompt another session queued (`omni session continue|ask`) goes only to the agent process it
 * was bound to, re-proven at the write and guarded by its process group at the PTY; a free
 * prompt also only while its conversation's turn re-check passes. A restart forgets the binding,
 * so it fails unsent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { drainPromptQueues, PROMPT_QUEUE_UNBOUND_RELAY } from './prompt-queue-drain'
import {
  conversationFence,
  conversationGuard,
  type SessionLatestTurn
} from '../session-manage/session-manage-freeform'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  bindSessionPrompt,
  releaseSessionPrompt,
  sessionPromptBinding,
  type SessionPromptBinding
} from './session-prompt-binding'

const PTY_SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const PTY_ROW = conversationSourceRowKey(PTY_SOURCE)
const DONE_HOOK = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }

type Harness = {
  runtime: OrcaRuntimeService
  persistence: PromptQueuePersistence
  journal: string[]
  prompts: { handle: string; text: string }[]
}

function harness(): Harness {
  const state = { promptQueues: {} } as unknown as PersistedState
  const journal: string[] = []
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: () => journal.push('flush'), writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const prompts: Harness['prompts'] = []
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
    listSessionChains: () => [],
    resolveTerminalPane: () => ({ handle: 'h', worktreeId: 'wt' }),
    getFreshAgentHookStatusForHandle: () => DONE_HOOK,
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    sendTerminalAgentPrompt: async (handle: string, text: string) => {
      journal.push('write')
      prompts.push({ handle, text })
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  return { runtime, persistence, journal, prompts }
}

function queueOne(test: Harness, text: string): void {
  test.persistence.enqueuePromptQueueEntry(PTY_SOURCE, {
    id: 'mine',
    text,
    createdAt: Date.now(),
    state: 'queued'
  })
}

function read(test: Harness): PromptQueue | null {
  return test.persistence.readPromptQueue(PTY_ROW)
}

describe('a prompt another session queued (omni session continue|ask)', () => {
  const PROOF = {
    ptyId: 'pty-1',
    incarnationId: null,
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: 1,
    agent: 'codex',
    via: 'command-line' as const
  }
  const queueRelayed = (
    test: Harness,
    holds: (ptyId: string) => boolean,
    binding: SessionPromptBinding | null = { receiver: PROOF }
  ) => {
    test.persistence.enqueuePromptQueueEntry(PTY_SOURCE, {
      id: 'session-manage:1',
      text: '[from Manager] Run the tests.',
      createdAt: Date.now(),
      state: 'queued',
      requestedBy: { action: 'continue', actor: 'tab-9:leaf-1' }
    })
    if (binding) {
      bindSessionPrompt(PTY_ROW, 'session-manage:1', binding)
    }
    const checks: string[] = []
    Object.assign(test.runtime, {
      assertTerminalAgentProcess: async (_proof: unknown, ptyId: string) => {
        checks.push(ptyId)
        if (!holds(ptyId)) {
          throw new Error('The agent it was queued for no longer holds its terminal.')
        }
      }
    })
    return checks
  }
  afterEach(() => releaseSessionPrompt(PTY_ROW, 'session-manage:1'))

  it('goes to the agent process it was queued for, re-proven at the write', async () => {
    const test = harness()
    const checks = queueRelayed(test, () => true)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts.map((prompt) => prompt.text)).toEqual(['[from Manager] Run the tests.'])
    expect(checks.length).toBeGreaterThanOrEqual(1)
    expect(sessionPromptBinding(PTY_ROW, 'session-manage:1')).toBeNull()
  })

  it('hands the bound process to the PTY’s guarded write', async () => {
    const test = harness()
    queueRelayed(test, () => true)
    const receivers: unknown[] = []
    const send = test.runtime.sendTerminalAgentPrompt.bind(test.runtime)
    Object.assign(test.runtime, {
      sendTerminalAgentPrompt: async (
        handle: string,
        text: string,
        opts: Parameters<OrcaRuntimeService['sendTerminalAgentPrompt']>[2]
      ) => {
        receivers.push(opts?.receiver)
        return send(handle, text, opts)
      }
    })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(receivers).toEqual([expect.objectContaining({ pid: 200, pgid: 200, startTimeMs: 1 })])
  })

  it('fails unsent when its conversation moved on since it was checked', async () => {
    const test = harness()
    const conversationGuard = vi.fn(async () => 'Its conversation moved on (a newer reply).')
    queueRelayed(test, () => true, { receiver: PROOF, conversationGuard })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(conversationGuard).toHaveBeenCalled()
    expect(test.journal).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('moved on')
    })
    expect(sessionPromptBinding(PTY_ROW, 'session-manage:1')).toBeNull()
  })

  describe('the conversation guard inside the guarded write (review 3, R4-3)', () => {
    const checked: SessionLatestTurn = {
      known: true,
      empty: false,
      turnKey: 't1',
      text: 'Tests pass.',
      complete: true,
      proposal: null
    }
    // The same turn, now proposing a deploy (a proposal parsed after the check).
    const deploy: SessionLatestTurn = { ...checked, proposal: '[["s1","Deploy to production"]]' }

    /** A prompt fenced to `checked`; the turn turns into `deploy` at `changeAt`. */
    const queueFenced = (test: Harness, changeAt: 'input-queue' | 'enter' | 'never') => {
      let now = checked
      const readTurn = vi.fn(async () => now)
      queueRelayed(test, () => true, {
        receiver: PROOF,
        conversationGuard: conversationGuard(conversationFence(checked, true), true, readTurn)
      })
      // The submission's own shape: the guard before the text, and again before Enter.
      Object.assign(test.runtime, {
        sendTerminalAgentPrompt: async (
          handle: string,
          text: string,
          opts: { beforeWrite?: (ptyId: string) => void | Promise<void> }
        ) => {
          now = changeAt === 'input-queue' ? deploy : now
          await opts.beforeWrite?.('pty-1')
          test.journal.push('write text')
          now = changeAt === 'enter' ? deploy : now
          await opts.beforeWrite?.('pty-1')
          test.journal.push('write enter')
          return { handle, accepted: true, bytesWritten: text.length }
        }
      })
      return readTurn
    }
    const writes = (test: Harness) => test.journal.filter((step) => step.startsWith('write'))

    it('writes neither the text nor Enter when a deploy proposal appears while it waits for the input queue', async () => {
      const test = harness()
      queueFenced(test, 'input-queue')
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      expect(writes(test)).toEqual([])
      expect(read(test)!.entries[0]).toMatchObject({
        state: 'failed',
        reason: expect.stringContaining('changed after this was checked')
      })
    })

    it('never writes Enter when it changes between the text and Enter', async () => {
      const test = harness()
      queueFenced(test, 'enter')
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      expect(writes(test)).toEqual(['write text'])
      expect(read(test)!.entries[0]).toMatchObject({ state: 'failed' })
    })

    it('reads the conversation before delivery and before each write, and delivers when it holds', async () => {
      const test = harness()
      const readTurn = queueFenced(test, 'never')
      await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
      expect(readTurn).toHaveBeenCalledTimes(3)
      expect(writes(test)).toEqual(['write text', 'write enter'])
      expect(read(test)?.entries[0]?.state).not.toBe('failed')
    })
  })

  it('keeps its binding when the person moves their own prompt ahead of it mid-check', async () => {
    const test = harness()
    queueRelayed(test, () => {
      test.persistence.reorderPromptQueueEntry(PTY_ROW, 'mine', 'up')
      return true
    })
    queueOne(test, 'My own message')

    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })

    expect(test.prompts).toEqual([])
    expect(read(test)!.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['mine', 'queued'],
      ['session-manage:1', 'queued']
    ])
    expect(sessionPromptBinding(PTY_ROW, 'session-manage:1')).not.toBeNull()
  })

  it('refuses a terminal prompt bound to no agent process', async () => {
    const test = harness()
    queueRelayed(test, () => true, { receiver: null })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({ reason: PROMPT_QUEUE_UNBOUND_RELAY })
  })

  it('is never written once that process no longer holds the terminal', async () => {
    const test = harness()
    queueRelayed(test, () => false)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.journal).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('no longer holds its terminal')
    })
  })

  it('stops at the write boundary when the agent is replaced mid-send', async () => {
    const test = harness()
    let calls = 0
    queueRelayed(test, () => ++calls === 1)
    const send = test.runtime.sendTerminalAgentPrompt.bind(test.runtime)
    Object.assign(test.runtime, {
      sendTerminalAgentPrompt: async (
        handle: string,
        text: string,
        opts: { beforeWrite?: (ptyId: string) => Promise<void> }
      ) => {
        await opts.beforeWrite?.('pty-1')
        return send(handle, text, opts)
      }
    })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({ state: 'failed' })
  })

  it('fails unsent after a restart: this process never held its binding', async () => {
    const test = harness()
    queueRelayed(test, () => true, null)
    await drainPromptQueues(test.runtime, { epoch: 'epoch-2' })
    expect(test.prompts).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_UNBOUND_RELAY
    })
  })

  it('fails unsent after a restart while its agent still works, so its sender can queue it again', async () => {
    const test = harness()
    queueRelayed(test, () => true, null)
    Object.assign(test.runtime, {
      getFreshAgentHookStatusForHandle: () => ({ ...DONE_HOOK, state: 'working' })
    })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-2' })
    expect(test.prompts).toEqual([])
    expect(read(test)!.entries[0]).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_UNBOUND_RELAY,
      unsent: true
    })
  })

  it('leaves the person’s own queued prompts to the ordinary rule', async () => {
    const test = harness()
    queueOne(test, 'My own message')
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toHaveLength(1)
  })
})
