/**
 * "Send now" and the queue drain share one conversation: one delivery in flight at a time, and the
 * queue waits for the agent to take up a prompt sent now exactly as it waits after its own.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import { PROMPT_QUEUE_ONE_IN_FLIGHT } from '../../shared/prompt-queue-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { sendConversationPromptNow } from './conversation-prompt-now'
import { drainPromptQueues } from './prompt-queue-drain'
import type { OrcaRuntimeService } from './omni-runtime'

const SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const ROW = conversationSourceRowKey(SOURCE)

function harness(options: { promptFails?: string } = {}) {
  const hook: Record<string, unknown> = { state: 'done', stateStartedAt: 10 }
  const persistence = new PromptQueuePersistence(
    { state: { promptQueues: {} } as unknown as PersistedState, flushOrThrow: () => {} },
    {} as WriteSchedulingOperations
  )
  const prompts: string[] = []
  const runtime = {
    listPromptQueues: () => persistence.listPromptQueues(),
    readPromptQueue: (rowKey: string) => persistence.readPromptQueue(rowKey),
    enqueuePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['enqueuePromptQueueEntry']>
    ) => persistence.enqueuePromptQueueEntry(...args),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => persistence.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => persistence.settlePromptQueueEntry(...args),
    listSessionChains: () => [],
    resolveTerminalPane: () => ({ handle: 'h', worktreeId: 'wt' }),
    getFreshAgentHookStatusForHandle: () => hook,
    getTerminalPaneKey: () => SOURCE.paneKey,
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    sendTerminalAgentPrompt: async (handle: string, text: string) => {
      if (options.promptFails) {
        throw new Error(options.promptFails)
      }
      prompts.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  const queue = (id: string, text: string): void => {
    persistence.enqueuePromptQueueEntry(SOURCE, { id, text, createdAt: 1, state: 'queued' })
  }
  const states = () => persistence.readPromptQueue(ROW)?.entries.map((entry) => entry.state)
  return { runtime, persistence, hook, prompts, queue, states }
}

describe('a prompt sent now on a conversation with a queue', () => {
  it('holds the next queued prompt until the agent has taken it up and finished', async () => {
    const test = harness()
    test.queue('e1', 'Queued')

    await sendConversationPromptNow(test.runtime, SOURCE, { id: 'e2', text: 'Now' }, 'epoch-1')
    // The pane still reads the turn that ended before "Now": the queue must not follow yet.
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toEqual(['Now'])

    Object.assign(test.hook, { state: 'working', stateStartedAt: 20 })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    Object.assign(test.hook, { state: 'done', stateStartedAt: 30 })
    await drainPromptQueues(test.runtime, { epoch: 'epoch-1' })
    expect(test.prompts).toEqual(['Now', 'Queued'])
  })

  it('is refused while a queued prompt is in flight, and waits in the queue instead', async () => {
    const test = harness()
    test.queue('e1', 'Queued')
    test.persistence.markPromptQueueEntrySendingAndFlush(ROW, 'e1', {
      operationId: 'prompt-queue:op',
      deliveryEpoch: 'epoch-1'
    })

    await expect(
      sendConversationPromptNow(test.runtime, SOURCE, { id: 'e2', text: 'Now' }, 'epoch-1')
    ).rejects.toThrow(PROMPT_QUEUE_ONE_IN_FLIGHT)
    expect(test.prompts).toEqual([])
    expect(test.states()).toEqual(['sending', 'queued'])
  })

  it('records a refusal before any byte moved as unsent', async () => {
    const test = harness({ promptFails: 'terminal_not_writable' })

    const result = await sendConversationPromptNow(
      test.runtime,
      SOURCE,
      { id: 'e1', text: 'Now' },
      'epoch-1'
    )

    expect(result.notSent).toBe(true)
    expect(result.entry).toMatchObject({ state: 'failed', unsent: true })
  })
})
