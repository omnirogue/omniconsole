/**
 * A turn a login failure killed leaves its pane "done but failed", which never reads free, so the
 * drain holds the person's prompts there. Only the login-resume continue prompt goes through, and
 * only when that failure was a login failure; a usage limit still holds everything.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({
  scheduleSave: vi.fn()
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { drainPromptQueues } from './prompt-queue-drain'
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

function harness(
  failureReason: string,
  evidence: Evidence = { proof: PROOF, tree: { kind: 'other' } }
) {
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
    // Claude's StopFailure: the turn is over, but it failed, so the pane does not read free.
    getFreshAgentHookStatusForHandle: () => ({
      state: 'done',
      failed: true,
      failureReason,
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
const LOGIN =
  'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}'
const CONTINUE = 'Your last turn was cut off at 14:05 by a login failure on this computer.'

describe('the drain on a pane whose last turn a login failure killed', () => {
  it('sends the login-resume continue prompt', async () => {
    const test = harness(LOGIN)
    test.queue('login-resume:abc', CONTINUE)

    await drain(test.runtime)

    expect(test.prompts).toEqual([CONTINUE])
  })

  it("holds the person's own prompt", async () => {
    const test = harness(LOGIN)
    test.queue('e1', 'Research the code')

    await drain(test.runtime)

    expect(test.prompts).toEqual([])
    expect(test.entries()[0]).toMatchObject({ id: 'e1', state: 'queued' })
  })

  it('holds the continue prompt too when the turn hit a usage limit instead', async () => {
    const test = harness("You've hit your limit · resets 5pm")
    test.queue('login-resume:abc', CONTINUE)

    await drain(test.runtime)

    expect(test.prompts).toEqual([])
    expect(test.entries()[0]).toMatchObject({ state: 'queued' })
  })

  it('never sends the continue prompt into a pane whose agent is gone', async () => {
    const test = harness(LOGIN, { proof: null, tree: { kind: 'agent-gone' } })
    test.queue('login-resume:abc', CONTINUE)

    await drain(test.runtime)

    expect(test.prompts).toEqual([])
    expect(test.entries()[0]).toMatchObject({ state: 'failed', unsent: true })
  })
})
