/**
 * A decision answer (`artifact-review`, `work-delivery`) goes to a Claude pane that is still
 * working, as long as nothing is open there and nobody is typing: Claude queues typed input. The
 * person's own prompts, other agents, and panes that cannot be read still wait for a free turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))

const pane = vi.hoisted(() => ({
  free: false,
  hook: {} as Record<string, unknown>,
  screen: {} as Record<string, unknown>,
  beforeWrite: null as (() => void) | null,
  duringWrite: null as (() => void) | null
}))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: pane.free,
    free: pane.free,
    unverifiable: false
  })
}))

import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { drainPromptQueues } from './prompt-queue-drain'
import { PROMPT_QUEUE_CONVERSATION_NOT_FREE } from './prompt-queue-answer-retry'
import type { OrcaRuntimeService } from './omni-runtime'
import { bindSessionPrompt, releaseSessionPrompt } from './session-prompt-binding'
import { isWriteFenceOpen, revokeWriteFencesWhere } from './conversation-write-fence'
import { GUARDED_WRITE_FENCE_REVOKED } from '../pty/guarded-pty-write'
import { claudeReportKeepsInput } from './prompt-queue-mid-turn'

const SOURCE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }
const ROW = conversationSourceRowKey(SOURCE)
const ID = 'artifact-review:1'
const TEXT = '[OmniOS decision] Approved.'
const T0 = Date.parse('2026-10-12T10:00:00Z')

function proof(agent: string) {
  return {
    ptyId: 'pty-1',
    incarnationId: null,
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: 1,
    agent,
    via: 'command-line' as const
  }
}

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
    getFreshAgentHookStatusForHandle: () => pane.hook,
    getTerminalPaneKey: () => 'tab-1:leaf-1',
    getTerminalProcessIncarnation: () => 'process:1',
    readTerminal: async () => pane.screen,
    assertTerminalAgentProcess: async () => {
      pane.beforeWrite?.()
    },
    sendTerminalAgentPrompt: async (
      handle: string,
      text: string,
      options: { beforeWrite?: (ptyId: string) => unknown; writeFence?: string }
    ) => {
      // Why: the writer runs its guard before the first byte, as the real submission does.
      await options.beforeWrite?.('pty-1')
      pane.duringWrite?.()
      // Why: the real writer refuses the Enter once its fence is revoked.
      if (options.writeFence && !isWriteFenceOpen(options.writeFence)) {
        throw new Error(GUARDED_WRITE_FENCE_REVOKED)
      }
      writes.push(text)
      return { handle, accepted: true, bytesWritten: text.length }
    }
  } as unknown as OrcaRuntimeService
  const queue = (options: { actor?: string; agent?: string } = {}) => {
    persistence.enqueuePromptQueueEntry(SOURCE, {
      id: ID,
      text: TEXT,
      createdAt: T0,
      state: 'queued',
      ...(options.actor === 'person'
        ? {}
        : { requestedBy: { action: 'continue', actor: options.actor ?? 'artifact-review' } })
    })
    bindSessionPrompt(ROW, ID, { receiver: proof(options.agent ?? 'claude') })
  }
  const entry = () => persistence.readPromptQueue(ROW)!.entries.find((row) => row.id === ID)!
  const drain = () => drainPromptQueues(runtime, { epoch: 'epoch-1' })
  return { queue, entry, drain, writes }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  pane.free = false
  pane.hook = {
    state: 'working',
    agentType: 'claude',
    onAttachedPty: true,
    interactivePrompt: null,
    stateStartedAt: 10,
    lastAssistantMessage: null
  }
  pane.screen = { status: 'running', source: 'screen', tail: ['❯ '] }
  pane.beforeWrite = null
  pane.duringWrite = null
})

/** A hook report for the pane as main hears it: the report itself, then the turn signal from it. */
function report(payload: Record<string, unknown>) {
  const onPane = (source: ConversationSource) => source.paneKey === SOURCE.paneKey
  revokeWriteFencesWhere(onPane, 'hook', {
    paneKey: SOURCE.paneKey,
    payload: { agentType: 'claude', ...payload }
  })
  revokeWriteFencesWhere(onPane, 'turn')
}
afterEach(() => {
  releaseSessionPrompt(ROW, ID)
  vi.useRealTimers()
})

describe('a decision answer for a Claude pane that is still working', () => {
  it('is typed now, for Claude to read at its next step', async () => {
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([TEXT])
    expect(test.entry().state).toBe('delivered')
  })

  it('also goes for a work delivery', async () => {
    const test = harness()
    test.queue({ actor: 'work-delivery' })
    await test.drain()
    expect(test.writes).toEqual([TEXT])
  })

  it('waits while the person is typing in that pane', async () => {
    pane.screen = { ...pane.screen, draft: 'half a sentence' }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry().state).toBe('queued')
  })

  it('goes past the prompt Claude suggests, which nobody typed', async () => {
    pane.screen = { ...pane.screen, draft: 'send the gamma credits', draftSuggested: true }
    const test = harness()
    test.queue({ actor: 'work-delivery' })
    await test.drain()
    expect(test.writes).toEqual([TEXT])
    expect(test.entry().state).toBe('delivered')
  })

  it('waits while Claude asks a question or for approval', async () => {
    pane.hook = { ...pane.hook, interactivePrompt: '{"questions":[]}' }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry().state).toBe('queued')
  })

  it('waits when this host cannot read the pane’s screen', async () => {
    pane.screen = { status: 'running', source: 'stream', tail: [] }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
  })

  it('still gets its Enter when Claude starts a turn while it is being typed', async () => {
    pane.free = true
    pane.hook = { ...pane.hook, state: 'idle' }
    pane.beforeWrite = () => {
      pane.free = false
      pane.hook = { ...pane.hook, state: 'working' }
    }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([TEXT])
    expect(test.entry().state).toBe('delivered')
  })

  it('keeps its Enter through Claude’s tool reports and its turn ending while it is typed', async () => {
    pane.duringWrite = () => {
      report({ state: 'working' })
      report({ state: 'done' })
    }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([TEXT])
    expect(test.entry().state).toBe('delivered')
  })

  it('is not typed when a question opens just before the write, and goes again later', async () => {
    pane.beforeWrite = () => {
      pane.hook = { ...pane.hook, state: 'waiting', interactivePrompt: '{"questions":[]}' }
    }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry()).toMatchObject({
      state: 'queued',
      retry: { attempts: 1, reason: PROMPT_QUEUE_CONVERSATION_NOT_FREE }
    })
  })
})

describe('what still waits for the turn to end', () => {
  it('the person’s own prompt', async () => {
    const test = harness()
    test.queue({ actor: 'person' })
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry().state).toBe('queued')
  })

  it('an answer bound to an agent other than Claude', async () => {
    pane.hook = { ...pane.hook, agentType: 'codex' }
    const test = harness()
    test.queue({ agent: 'codex' })
    await test.drain()
    expect(test.writes).toEqual([])
  })

  it('a pane whose report is not from its own attached terminal', async () => {
    pane.hook = { ...pane.hook, onAttachedPty: false }
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
  })
})

describe('what a report while it is typed still stops', () => {
  it('a Claude answer, when the report opens a question', async () => {
    pane.duringWrite = () => report({ state: 'waiting', interactivePrompt: '{"questions":[]}' })
    const test = harness()
    test.queue()
    await test.drain()
    expect(test.writes).toEqual([])
    expect(test.entry().state).not.toBe('delivered')
  })

  it('a relayed prompt that is not an answer, on any report', async () => {
    pane.free = true
    pane.hook = { ...pane.hook, state: 'done' }
    pane.duringWrite = () => report({ state: 'working' })
    const test = harness()
    test.queue({ actor: 'session-continue' })
    await test.drain()
    expect(test.writes).toEqual([])
  })
})

describe('claudeReportKeepsInput', () => {
  it.each([
    ['working', { state: 'working' }, true],
    ['done', { state: 'done' }, true],
    ['a question', { state: 'waiting', interactivePrompt: '{"questions":[]}' }, false],
    ['blocked', { state: 'blocked' }, false],
    ['another agent', { state: 'working', agentType: 'codex' }, false],
    ['a session boundary', { state: 'done', sessionBoundary: true }, false]
  ])('%s', (_, payload, keeps) => {
    expect(claudeReportKeepsInput({ payload: { agentType: 'claude', ...payload } })).toBe(keeps)
  })

  it('not an identity-only report', () => {
    const payload = { agentType: 'claude', state: 'working' }
    expect(claudeReportKeepsInput({ providerSessionOnly: true, payload })).toBe(false)
  })
})
