/**
 * Sal's decision (2026-09-27): after one of the person's queued prompts fails, their queue waits
 * until they dismiss it or queue it again. Keep going rounds and prompts another session queued
 * keep draining, so unattended work never stalls behind a failure nobody is watching.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import {
  normalizePromptQueues,
  type PromptQueue,
  type PromptQueueEnqueueInput
} from '../../shared/prompt-queue-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { drainPromptQueues } from './prompt-queue-drain'
import type { OrcaRuntimeService } from './omni-runtime'
import type { NextStepKeepGoingController } from '../next-steps/next-step-keep-going'
import { setNextStepKeepGoingController } from '../next-steps/next-step-suggestion-slot'
import { bindSessionPrompt, releaseSessionPrompt } from './session-prompt-binding'

const SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const ROW = conversationSourceRowKey(SOURCE)
const DONE_HOOK = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }
const KEEP_GOING = { kind: 'keep-going' as const, runToken: 'run001', round: 1 }

type Harness = {
  runtime: OrcaRuntimeService
  state: PersistedState
  persistence: PromptQueuePersistence
  prompts: string[]
  failWrites: boolean
}

/** A fresh runtime per tick keeps the post-delivery hold of the previous one out of the way. */
function harness(state = { promptQueues: {} } as unknown as PersistedState): Harness {
  const persistence = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  const test = { state, persistence, prompts: [] as string[], failWrites: false } as Harness
  test.runtime = {
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
    getFreshAgentHookStatusForHandle: () => DONE_HOOK,
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    assertTerminalAgentProcess: async () => {},
    sendTerminalAgentPrompt: async (handle: string, text: string) => {
      if (test.failWrites) {
        throw new Error('terminal_not_writable')
      }
      test.prompts.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  return test
}

function queue(
  test: Harness,
  id: string,
  text: string,
  over: Partial<PromptQueueEnqueueInput> = {}
) {
  test.persistence.enqueuePromptQueueEntry(SOURCE, {
    id,
    text,
    createdAt: Date.now(),
    state: 'queued',
    ...over
  })
}

const read = (test: Harness): PromptQueue => test.persistence.readPromptQueue(ROW)!

/** "Research the code" fails on the wire; "Now plan it" waits behind it unless `alone`. */
async function pausedBehindFailure(alone = false): Promise<Harness> {
  const test = harness()
  queue(test, 'e1', 'Research the code')
  if (!alone) {
    queue(test, 'e2', 'Now plan it')
  }
  test.failWrites = true
  await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
  test.failWrites = false
  return test
}

/** The next tick, on the same state, as a later tick or a restarted process would see it. */
async function nextTick(test: Harness, epoch = 'epoch-1'): Promise<Harness> {
  const next = harness(test.state)
  await drainPromptQueues(next.runtime, { epoch })
  return next
}

afterEach(() => {
  setNextStepKeepGoingController(null)
  releaseSessionPrompt(ROW, 'session-manage:1')
})

describe('a queue paused behind the person’s failed prompt', () => {
  it('sends nothing more of the person’s until they act', async () => {
    const test = await pausedBehindFailure()
    expect(read(test).entries[0]).toMatchObject({ state: 'failed', holdsQueue: true })

    expect((await nextTick(test)).prompts).toEqual([])
    expect((await nextTick(test)).prompts).toEqual([])
    expect(read(test).entries[1]).toMatchObject({ id: 'e2', state: 'queued' })
  })

  it('stays paused after a restart', async () => {
    const test = await pausedBehindFailure()
    const reloaded = harness(
      JSON.parse(
        JSON.stringify({ promptQueues: normalizePromptQueues(test.state.promptQueues) })
      ) as PersistedState
    )
    expect((await nextTick(reloaded, 'epoch-after-restart')).prompts).toEqual([])
  })

  it('resumes with the next prompt once the failed one is dismissed', async () => {
    const test = await pausedBehindFailure()
    test.persistence.removePromptQueueEntry(ROW, 'e1')
    expect((await nextTick(test)).prompts).toEqual(['Now plan it'])
  })

  it('resumes with the failed prompt first once it is queued again', async () => {
    const test = await pausedBehindFailure()
    test.persistence.requeuePromptQueueEntry(ROW, 'e1', { id: 'e1-again', createdAt: 5 })
    expect((await nextTick(test)).prompts).toEqual(['Research the code'])
    expect(read(test).entries.map((entry) => [entry.id, entry.state])).toEqual([
      ['e1-again', 'delivered'],
      ['e2', 'queued']
    ])
  })

  it('still sends a Keep going round', async () => {
    // Keep going yields to a WAITING prompt of the person's on its own; a failed one does not stop it.
    const test = await pausedBehindFailure(true)
    queue(test, 'next-step:set-1:s1', '[Keep going 1/3] Add a test.', { origin: KEEP_GOING })
    const onDelivered = vi.fn()
    setNextStepKeepGoingController({
      assertDelivery: vi.fn(),
      onDelivered
    } as unknown as NextStepKeepGoingController)

    expect((await nextTick(test)).prompts).toEqual(['[Keep going 1/3] Add a test.'])
    expect(onDelivered).toHaveBeenCalledOnce()
    expect(read(test).entries[0]).toMatchObject({ id: 'e1', state: 'failed', holdsQueue: true })
  })

  it('still sends a prompt another session queued, past the person’s waiting prompts', async () => {
    const test = await pausedBehindFailure()
    queue(test, 'session-manage:1', '[from steward] Run the tests.', {
      requestedBy: { action: 'continue', actor: 'steward' }
    })
    bindSessionPrompt(ROW, 'session-manage:1', {
      receiver: {
        ptyId: 'pty-1',
        incarnationId: null,
        rootPid: 100,
        pid: 200,
        pgid: 200,
        startTimeMs: 1,
        agent: 'codex',
        via: 'command-line'
      }
    })

    expect((await nextTick(test)).prompts).toEqual(['[from steward] Run the tests.'])
  })

  it('is not paused when a Keep going round fails', async () => {
    const test = harness()
    queue(test, 'next-step:set-1:s1', '[Keep going 1/3] Add a test.', { origin: KEEP_GOING })
    queue(test, 'e2', 'Now plan it')
    // No Keep going on this host: the round is withdrawn unsent.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(read(test).entries[0]).toMatchObject({ state: 'failed' })
    expect(read(test).entries[0]!.holdsQueue).toBeUndefined()

    expect((await nextTick(test)).prompts).toEqual(['Now plan it'])
  })
})
