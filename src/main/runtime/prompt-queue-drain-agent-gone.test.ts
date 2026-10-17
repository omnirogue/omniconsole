/**
 * Live check of #826 (2026-09-27): after the agent exited, its pane read free and the drain typed
 * the person's queued prompt into the bare shell, which ran it as a command. A pane proven to have
 * no agent now refuses the prompt unsent, and the pause from #826 holds the rest.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({
  scheduleSave: vi.fn()
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { sendConversationPromptNow } from './conversation-prompt-now'
import { drainPromptQueues } from './prompt-queue-drain'
import { PROMPT_QUEUE_AGENT_NOT_RUNNING } from './prompt-queue-agent-presence'
import type { OrcaRuntimeService } from './omni-runtime'
import type { TerminalAgentProcessProof, TerminalProcessTree } from './terminal-agent-process'

const SOURCE: ConversationSource = {
  worktreeId: 'wt',
  paneKey: 'tab-1:leaf-1',
  kind: 'pty'
}
const ROW = conversationSourceRowKey(SOURCE)
const PROOF: TerminalAgentProcessProof = {
  ptyId: 'pty-1',
  incarnationId: null,
  rootPid: 100,
  pid: 200,
  pgid: 200,
  startTimeMs: 1,
  agent: 'claude',
  via: 'command-line'
}

type Evidence = {
  proof: TerminalAgentProcessProof | null
  tree: TerminalProcessTree
} | null

function harness(evidence: Evidence) {
  const persistence = new PromptQueuePersistence(
    {
      state: { promptQueues: {} } as unknown as PersistedState,
      flushOrThrow: () => {}
    },
    {} as WriteSchedulingOperations
  )
  const prompts: string[] = []
  const agent = { holds: true }
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
    // An idle shell reads "done" too: the hook row outlives the agent that wrote it.
    getFreshAgentHookStatusForHandle: () => ({
      state: 'done',
      stateStartedAt: 10
    }),
    getTerminalPaneKey: () => SOURCE.paneKey,
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => ({ status: 'running', tail: [] }),
    readTerminalProcessEvidence: async () => evidence,
    assertTerminalAgentProcess: async () => {
      if (!agent.holds) {
        throw new Error('The agent it was queued for no longer holds its terminal.')
      }
    },
    sendTerminalAgentPrompt: async (
      handle: string,
      text: string,
      options: { beforeWrite?: (ptyId: string) => void | Promise<void> }
    ) => {
      await options.beforeWrite?.('pty-1')
      prompts.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  const queue = (id: string, text: string): void => {
    persistence.enqueuePromptQueueEntry(SOURCE, {
      id,
      text,
      createdAt: 1,
      state: 'queued'
    })
  }
  const entries = () => persistence.readPromptQueue(ROW)!.entries
  return { runtime, prompts, agent, queue, entries }
}

const drain = (runtime: OrcaRuntimeService) => drainPromptQueues(runtime, { epoch: 'epoch-1' })

describe('a person’s queued prompt on a pane whose agent is gone', () => {
  it('is refused unsent, never typed into the shell, and pauses the queue', async () => {
    const test = harness({ proof: null, tree: { kind: 'agent-gone' } })
    test.queue('e1', 'Reply with the single word ALPHA')
    test.queue('e2', 'Reply with the single word BRAVO')

    await drain(test.runtime)
    await drain(test.runtime)

    expect(test.prompts).toEqual([])
    expect(test.entries()[0]).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_AGENT_NOT_RUNNING,
      unsent: true,
      holdsQueue: true
    })
    expect(test.entries()[1]).toMatchObject({ id: 'e2', state: 'queued' })
  })

  it('is refused when the proven agent exits before the write', async () => {
    const test = harness({ proof: PROOF, tree: { kind: 'other' } })
    test.queue('e1', 'Research the code')
    test.agent.holds = false

    await drain(test.runtime)

    expect(test.prompts).toEqual([])
    expect(test.entries()[0]).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_AGENT_NOT_RUNNING,
      unsent: true
    })
  })

  it('goes to a proven agent', async () => {
    const test = harness({ proof: PROOF, tree: { kind: 'other' } })
    test.queue('e1', 'Research the code')

    await drain(test.runtime)

    expect(test.prompts).toEqual(['Research the code'])
  })

  it('still goes when the pane’s processes cannot be read (loss of contact is not an exit)', async () => {
    const test = harness(null)
    test.queue('e1', 'Research the code')

    await drain(test.runtime)

    expect(test.prompts).toEqual(['Research the code'])
  })

  it('is refused when sent now, too', async () => {
    const test = harness({ proof: null, tree: { kind: 'agent-gone' } })

    const result = await sendConversationPromptNow(
      test.runtime,
      SOURCE,
      { id: 'n1', text: 'Now' },
      'epoch-1'
    )

    expect(test.prompts).toEqual([])
    expect(result.notSent).toBe(true)
    expect(result.entry).toMatchObject({
      state: 'failed',
      reason: PROMPT_QUEUE_AGENT_NOT_RUNNING
    })
  })
})
