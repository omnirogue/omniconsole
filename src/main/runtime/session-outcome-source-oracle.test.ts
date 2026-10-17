/**
 * One table for the three observers that decide whether a source session finished.
 *
 * Why: readiness is agreed from #289's host turn state, #283's journal observation and the PTY
 * hook row, any exception among them is flattened into one generic "unverifiable" by a bare
 * catch, and a stored sourceReady survives only that unverifiable answer. Each observer was
 * pinned by its own author's tests, so the AGREEMENT between them — which refusal wins, which
 * one a stored receipt may outlive — was only ever tested in fragments. The rows below drive
 * every combination through both entry points and assert ready, unverifiable and the reason.
 *
 * Two rows are marked KNOWN GAP: #292 named the provider's own failure text ("API usage limit
 * reached") on the PTY branch only, so the structured and journal branches still answer a
 * failed turn with a constant. This file records that gap; it does not change production.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { resolveSessionOutcomeSourceReadiness } from './session-outcome-source-readiness'
import { observeStructuredAgentSessionOutcome } from '../../shared/structured-agent-session-outcome-observation'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentJournalTurnOutcome } from '../../shared/agent-session-journal-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat-1'), 'chat-1')

const INTERRUPTED =
  'The source session was interrupted before it finished. Run it again before continuing.'
const FAILED = 'The source session failed before it finished.'
const UNSETTLED =
  'The source session never recorded how its turn ended, so it cannot count as finished.'
const UNVERIFIABLE =
  'Source execution is unverifiable. Restore its host or source session before continuing.'
const NO_RECEIPT = 'The latest source turn has no confirmed admission receipt.'

type Turn = {
  running: boolean
  hasTurn: boolean
  awaitingStart?: boolean
  outcome?: AgentJournalTurnOutcome
  lastSequence: number
}
type Hook = Record<string, unknown>
type Journal = { sessionId: string; submissions: unknown[]; items: unknown[] }

const submission = (providerItemId?: string) => ({
  clientMessageId: 'c1',
  dispatchState: 'accepted',
  ...(providerItemId ? { providerItemId } : {})
})
const userTurn = {
  itemId: agentJournalSubmissionKey('c1'),
  sequence: 1,
  body: { kind: 'message', role: 'user', blocks: [] }
}
const settledRow = (outcome: 'succeeded' | 'failed') => ({
  itemId: 'lifecycle',
  sequence: 2,
  body: {
    kind: 'status',
    turnLifecycle: {
      turnId: 't1',
      state: 'completed',
      settlement: { providerItemId: 'p1', outcome }
    }
  }
})

const JOURNAL = {
  none: { sessionId: 'chat-1', submissions: [], items: [] },
  noReceipt: { sessionId: 'chat-1', submissions: [submission()], items: [userTurn] },
  approval: {
    sessionId: 'chat-1',
    submissions: [submission('p1')],
    items: [
      userTurn,
      { itemId: 'ask', sequence: 2, body: { kind: 'approval', resolution: { state: 'pending' } } }
    ]
  },
  unsettled: { sessionId: 'chat-1', submissions: [submission('p1')], items: [userTurn] },
  failed: {
    sessionId: 'chat-1',
    submissions: [submission('p1')],
    items: [userTurn, settledRow('failed')]
  },
  succeeded: {
    sessionId: 'chat-1',
    submissions: [submission('p1')],
    items: [userTurn, settledRow('succeeded')]
  }
} satisfies Record<string, Journal>

const DONE: Hook = { state: 'done', stateStartedAt: 10, lastAssistantMessage: 'Finished.' }

type Row = {
  name: string
  /** #289's host turn state. `throws` stands for a host that fails while being read. */
  turn?: Turn | 'throws'
  /** #283's journal reading, computed by the real observer from this snapshot. */
  journal?: Journal | 'throws'
  /** The agent hook row on a PTY source; `lost` stands for a pane this host no longer holds. */
  hook?: Hook | 'lost'
  /** Whether the completed-turn identity is still resolvable. */
  identity?: false
  read?: { status: string; tail: string[] }
  successfulOnly?: true
  stored?: { sourceReady?: boolean; sourceVersion?: string }
  ready: boolean
  unverifiable: boolean
  /** The whole sentence where the branch uses a constant; the naming fragment otherwise. */
  reason: string | null
  /** resolveSessionOutcomeSourceReadiness, which may keep a stored receipt alive. */
  resolvedReady: boolean
}

const ROWS: Row[] = [
  {
    name: 'a chat turn that is still running demotes a stored receipt',
    turn: { running: true, hasTurn: true, outcome: 'unknown', lastSequence: 4 },
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: false,
    reason: null,
    resolvedReady: false
  },
  {
    name: 'a chat session that has taken no turn yet',
    turn: { running: false, hasTurn: false, outcome: 'unknown', lastSequence: 0 },
    ready: false,
    unverifiable: false,
    reason: null,
    resolvedReady: false
  },
  {
    name: 'an interrupted chat turn',
    turn: { running: false, hasTurn: true, outcome: 'interrupted', lastSequence: 7 },
    ready: false,
    unverifiable: false,
    reason: INTERRUPTED,
    resolvedReady: false
  },
  {
    // KNOWN GAP: #292's describeAgentTurnFailure reached the PTY branch only, so this
    // branch cannot say WHY the turn failed. Pinned as the constant it returns today.
    name: 'a failed chat turn, named only by a constant',
    turn: { running: false, hasTurn: true, outcome: 'failed', lastSequence: 7 },
    ready: false,
    unverifiable: false,
    reason: FAILED,
    resolvedReady: false
  },
  {
    name: 'a chat turn that never recorded how it ended keeps a stored receipt',
    turn: { running: false, hasTurn: true, outcome: 'unknown', lastSequence: 7 },
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: true,
    reason: UNSETTLED,
    resolvedReady: true
  },
  {
    name: 'a completed chat turn',
    turn: { running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 },
    ready: true,
    unverifiable: false,
    reason: null,
    resolvedReady: true
  },
  {
    name: 'a journal with no submitted turn',
    journal: JOURNAL.none,
    ready: false,
    unverifiable: false,
    reason: 'The source session has no submitted turn.',
    resolvedReady: false
  },
  {
    name: 'a journal whose latest turn has no admission receipt',
    journal: JOURNAL.noReceipt,
    ready: false,
    unverifiable: true,
    reason: NO_RECEIPT,
    resolvedReady: false
  },
  {
    name: 'a journal waiting on an approval',
    journal: JOURNAL.approval,
    ready: false,
    unverifiable: false,
    reason: 'The source agent needs your input.',
    resolvedReady: false
  },
  {
    // KNOWN GAP: the journal branch also answers a failed settlement with a constant.
    name: 'a journal whose turn settled as failed, named only by a constant',
    journal: JOURNAL.failed,
    ready: false,
    unverifiable: false,
    reason: 'The latest source turn did not finish successfully.',
    resolvedReady: false
  },
  {
    name: 'a journal with no settled lifecycle row',
    journal: JOURNAL.unsettled,
    ready: false,
    unverifiable: true,
    reason: 'The latest source turn has no verified successful completion.',
    resolvedReady: false
  },
  {
    name: 'a journal with a successful settlement',
    journal: JOURNAL.succeeded,
    ready: true,
    unverifiable: false,
    reason: null,
    resolvedReady: true
  },
  {
    name: 'a settled host turn the journal cannot confirm',
    turn: { running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 },
    journal: JOURNAL.noReceipt,
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: true,
    reason: NO_RECEIPT,
    resolvedReady: true
  },
  {
    // A definite refusal is reported ahead of an unverifiable one, so a real failure is named
    // rather than reported as loss of contact — and no stored receipt can outlive it.
    name: 'a failed host turn beside an unverifiable journal',
    turn: { running: false, hasTurn: true, outcome: 'failed', lastSequence: 7 },
    journal: JOURNAL.noReceipt,
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: false,
    reason: FAILED,
    resolvedReady: false
  },
  {
    name: 'both readings agreeing that the turn finished',
    turn: { running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 },
    journal: JOURNAL.succeeded,
    ready: true,
    unverifiable: false,
    reason: null,
    resolvedReady: true
  },
  {
    // The bare catch flattens ANY observer exception, including one thrown beside a reading
    // that said the turn finished. Loss of contact is never an exit.
    name: 'an observer that throws beside a completed turn',
    turn: { running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 },
    journal: 'throws',
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: true,
    reason: UNVERIFIABLE,
    resolvedReady: true
  },
  {
    name: 'a host that throws while its turn state is read',
    turn: 'throws',
    ready: false,
    unverifiable: true,
    reason: UNVERIFIABLE,
    resolvedReady: false
  },
  {
    name: 'a PTY turn that ended by interrupt',
    hook: { ...DONE, interrupted: true },
    ready: false,
    unverifiable: false,
    reason: INTERRUPTED,
    resolvedReady: false
  },
  {
    // #292: this branch quotes what the agent itself said killed the turn.
    name: 'a PTY turn that died on a quota wall',
    hook: { ...DONE, failed: true, failureReason: 'API usage limit reached.' },
    ready: false,
    unverifiable: false,
    reason: 'The agent stopped without finishing: API usage limit reached.',
    resolvedReady: false
  },
  {
    name: 'a PTY turn that ended with no reported reason',
    hook: { ...DONE, failed: true },
    ready: false,
    unverifiable: false,
    reason: 'The agent stopped without finishing and reported no reason.',
    resolvedReady: false
  },
  {
    name: 'a PTY turn across a session boundary',
    hook: { ...DONE, sessionBoundary: true },
    ready: false,
    unverifiable: false,
    reason: 'The source has no successful completed turn.',
    resolvedReady: false
  },
  {
    name: 'a PTY turn holding an interactive prompt',
    hook: { ...DONE, interactivePrompt: 'Which file?' },
    ready: false,
    unverifiable: false,
    reason: 'Which file?',
    resolvedReady: false
  },
  {
    name: 'a PTY turn carrying an async question, named in words',
    hook: {
      ...DONE,
      interactivePrompt: JSON.stringify({
        delivery: 'async',
        asyncQuestions: [{ question: 'Which color?', multiSelect: false, options: [] }]
      })
    },
    ready: false,
    unverifiable: false,
    reason: 'The agent is waiting for your answer: Which color?',
    resolvedReady: false
  },
  {
    name: 'a PTY turn whose completed-turn identity is gone',
    hook: DONE,
    identity: false,
    ready: false,
    unverifiable: true,
    reason: UNVERIFIABLE,
    resolvedReady: false
  },
  {
    name: 'a PTY agent still working',
    hook: { state: 'working', stateStartedAt: 20 },
    ready: false,
    unverifiable: false,
    reason: null,
    resolvedReady: false
  },
  {
    name: 'a PTY agent blocked on a question',
    hook: { state: 'blocked', interactivePrompt: 'Choose an option' },
    ready: false,
    unverifiable: false,
    reason: 'Choose an option',
    resolvedReady: false
  },
  {
    name: 'a terminal that merely exited',
    read: { status: 'exited', tail: ['bye'] },
    ready: true,
    unverifiable: false,
    reason: null,
    resolvedReady: true
  },
  {
    // #284: with a planning source, an exit is not a successful turn.
    name: 'the same exited terminal when only a success counts',
    read: { status: 'exited', tail: ['bye'] },
    successfulOnly: true,
    ready: false,
    unverifiable: true,
    reason: UNVERIFIABLE,
    resolvedReady: false
  },
  {
    name: 'a terminal still running',
    read: { status: 'running', tail: [] },
    ready: false,
    unverifiable: false,
    reason: null,
    resolvedReady: false
  },
  {
    // #289: loss of contact is the ONE observation a stored receipt survives.
    name: 'a pane this host no longer holds keeps a stored receipt',
    hook: 'lost',
    stored: { sourceReady: true, sourceVersion: 'v1' },
    ready: false,
    unverifiable: true,
    reason: UNVERIFIABLE,
    resolvedReady: true
  }
]

function install(row: Row): void {
  if (row.turn === undefined && row.journal === undefined) {
    setStructuredAgentSessionHost(null)
    return
  }
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: 'wt', agent: 'claude' }],
    turnState: () => {
      if (row.turn === 'throws') {
        throw new Error('the structured host went away')
      }
      return row.turn ?? null
    },
    ...(row.journal === undefined
      ? {}
      : {
          outcomeSource: {
            observe: () => {
              if (row.journal === 'throws') {
                throw new Error('the journal went away')
              }
              return observeStructuredAgentSessionOutcome(row.journal as never)
            }
          }
        })
  } as never)
}

function runtimeOf(row: Row): OrcaRuntimeService {
  return {
    resolveTerminalPane: () => {
      if (row.hook === 'lost') {
        throw new Error('the pane is gone')
      }
      return { handle: 'h', worktreeId: 'wt' }
    },
    getFreshAgentHookStatusForHandle: () => (row.hook === 'lost' ? null : (row.hook ?? null)),
    getTerminalPaneKey: () => 'tab:leaf',
    getTerminalProcessIncarnation: () => (row.identity === false ? undefined : 'process:1'),
    readTerminal: async () => row.read ?? { status: 'running', tail: [] }
  } as unknown as OrcaRuntimeService
}

function chainOf(row: Row): SessionChain {
  return {
    sourcePaneKey: paneKey,
    worktreeId: 'wt',
    steps: [],
    outcomeSet: { continuation: row.stored ?? {} }
  } as unknown as SessionChain
}

const options = (row: Row) => (row.successfulOnly ? { successfulOnly: true as const } : undefined)

describe('what the source observers agree on', () => {
  it.each(ROWS)('$name', async (row) => {
    install(row)
    const observed = await observeSessionOutcomeSource(runtimeOf(row), chainOf(row), options(row))
    expect(observed.ready).toBe(row.ready)
    expect(Boolean(observed.unverifiable)).toBe(row.unverifiable)
    if (row.reason === null) {
      expect(observed.reason).toBeUndefined()
    } else {
      expect(observed.reason).toContain(row.reason)
    }
    // A ready reading always carries the identity it was read from; without it a later ping
    // cannot tell the same finished turn from a replacement one.
    expect(typeof observed.version === 'string' && observed.version.length > 0).toBe(row.ready)
  })

  it.each(ROWS)('$name: readiness resolution', async (row) => {
    install(row)
    const resolved = await resolveSessionOutcomeSourceReadiness(
      runtimeOf(row),
      chainOf(row),
      options(row)
    )
    expect(resolved.ready).toBe(row.resolvedReady)
    // A stored receipt that outlives an unverifiable observation keeps its stored version and
    // stays marked unverifiable, so nothing downstream mistakes it for a fresh reading.
    if (row.resolvedReady && !row.ready) {
      expect(resolved).toEqual({ ready: true, unverifiable: true, version: 'v1' })
    }
  })
})

describe('what a stored receipt may and may not outlive', () => {
  const rows = ROWS.filter((row) => row.stored?.sourceReady)

  it.each(rows)('$name', async (row) => {
    install(row)
    const observed = await observeSessionOutcomeSource(runtimeOf(row), chainOf(row), options(row))
    // The rule, stated once: a stored receipt survives exactly the observations that could not
    // be made, and no observation that was.
    expect(row.resolvedReady).toBe(observed.ready || Boolean(observed.unverifiable))
  })
})
