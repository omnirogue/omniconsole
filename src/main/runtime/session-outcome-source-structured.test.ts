import { afterEach, expect, it, vi } from 'vitest'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { readStructuredAgentSessionTurnState } from '../native-chat/agent-session-wire/structured-agent-session-host-turn-state'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentJournalTurnOutcome } from '../../shared/agent-session-journal-types'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat-1'), 'chat-1')

function runtime() {
  return {
    resolveTerminalPane: vi.fn(() => {
      throw new Error('no PTY')
    })
  } as unknown as OrcaRuntimeService
}

function chain(sourcePaneKey = paneKey): SessionChain {
  return { sourcePaneKey, worktreeId: 'wt', steps: [] } as unknown as SessionChain
}

type Turn = {
  running: boolean
  hasTurn: boolean
  awaitingStart?: boolean
  outcome?: AgentJournalTurnOutcome
  lastSequence: number
}

function host(turn: Turn | null) {
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: 'wt', agent: 'claude' }],
    turnState: vi.fn(() => turn)
  } as never)
}

/** Installs a host whose turn facts come from the real journal reader. */
function journalHost(items: unknown[]) {
  setStructuredAgentSessionHost({
    listSessionTabs: () => [{ sessionId: 'chat-1', workspaceId: 'wt', agent: 'codex' }],
    turnState: (sessionId: string) =>
      readStructuredAgentSessionTurnState(
        new Map([['chat-1', { journal: { snapshot: () => ({ items }) } }]]) as never,
        sessionId
      )
  } as never)
}

const message = (sequence: number, role: 'user' | 'assistant') => ({
  itemId: `m${sequence}`,
  revision: 1,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [] }
})

it('waits on a chat source whose turn is still running', async () => {
  host({ running: true, hasTurn: true, outcome: 'unknown', lastSequence: 4 })
  await expect(observeSessionOutcomeSource(runtime(), chain())).resolves.toEqual({ ready: false })
})

it('waits on a chat source that has not taken a turn yet', async () => {
  host({ running: false, hasTurn: false, outcome: 'unknown', lastSequence: 0 })
  // Not ready — there is no turn to build on — and `idle`, because there is none in flight
  // either: the chain still waits, the person's own next message does not.
  await expect(observeSessionOutcomeSource(runtime(), chain())).resolves.toEqual({
    ready: false,
    idle: true
  })
})

it('waits on a submitted message whose provider turn has not reported running yet', async () => {
  journalHost([message(1, 'user')])
  await expect(observeSessionOutcomeSource(runtime(), chain())).resolves.toEqual({ ready: false })
})

it('marks a finished chat source ready with a version that follows its journal', async () => {
  host({ running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 })
  const first = await observeSessionOutcomeSource(runtime(), chain())
  host({ running: false, hasTurn: true, outcome: 'completed', lastSequence: 9 })
  const later = await observeSessionOutcomeSource(runtime(), chain())
  expect(first).toMatchObject({ ready: true })
  expect(first.version).toMatch(/^[a-f0-9]{64}$/)
  expect(later.version).not.toBe(first.version)
})

it('never reports an interrupted or failed chat turn as finished', async () => {
  host({ running: false, hasTurn: true, outcome: 'interrupted', lastSequence: 7 })
  const interrupted = await observeSessionOutcomeSource(runtime(), chain())
  host({ running: false, hasTurn: true, outcome: 'failed', lastSequence: 7 })
  const failed = await observeSessionOutcomeSource(runtime(), chain())
  expect(interrupted.ready).toBe(false)
  expect(interrupted.reason).toMatch(/interrupted/i)
  expect(failed).toMatchObject({ ready: false })
  expect(failed.reason).toMatch(/failed/i)
})

it('treats assistant output with no settled lifecycle row as unverifiable, never finished', async () => {
  // The durable shape a tombstoned Codex turn leaves behind: partial text, no outcome row.
  journalHost([message(1, 'user'), message(2, 'assistant')])
  await expect(observeSessionOutcomeSource(runtime(), chain())).resolves.toMatchObject({
    ready: false,
    unverifiable: true
  })
})

it('reports a chat source this host does not hold as unverifiable, never exited', async () => {
  host({ running: false, hasTurn: true, outcome: 'completed', lastSequence: 7 })
  const other = await observeSessionOutcomeSource(runtime(), chain('tab:other'))
  expect(other).toMatchObject({ ready: false, unverifiable: true })
  setStructuredAgentSessionHost(null)
  const missing = await observeSessionOutcomeSource(runtime(), chain())
  expect(missing).toMatchObject({ ready: false, unverifiable: true })
})

it('keeps the chat source unverifiable when its journal is not attached', async () => {
  host(null)
  await expect(observeSessionOutcomeSource(runtime(), chain())).resolves.toMatchObject({
    ready: false,
    unverifiable: true
  })
})

it('never reports an interrupted terminal turn as finished', async () => {
  const terminalRuntime = {
    resolveTerminalPane: () => ({ handle: 'source' }),
    getFreshAgentHookStatusForHandle: () => ({
      state: 'done',
      interrupted: true,
      lastAssistantMessage: 'partial',
      interactivePrompt: null,
      stateStartedAt: 1,
      updatedAt: Date.now()
    }),
    readTerminal: async () => ({ status: 'running', tail: [] })
  } as unknown as OrcaRuntimeService
  const observed = await observeSessionOutcomeSource(terminalRuntime, {
    sourcePaneKey: 'source',
    worktreeId: 'wt',
    steps: []
  } as unknown as SessionChain)
  expect(observed.ready).toBe(false)
  expect(observed.reason).toMatch(/interrupted/i)
})
