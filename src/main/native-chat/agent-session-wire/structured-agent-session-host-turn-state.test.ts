import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readStructuredAgentSessionTurnState } from './structured-agent-session-host-turn-state'

function item(sequence: number, body: unknown): AgentJournalRenderItem {
  return { itemId: `i${sequence}`, revision: 1, sequence, observedAt: sequence, body } as never
}

function sessions(items: AgentJournalRenderItem[]) {
  return new Map([['chat', { journal: { snapshot: () => ({ items }) } }]])
}

const user = (sequence: number) => item(sequence, { kind: 'message', role: 'user' })
const lifecycle = (
  sequence: number,
  state: 'running' | 'completed',
  outcome?: 'completed' | 'interrupted' | 'failed' | 'unknown'
) =>
  item(sequence, {
    kind: 'status',
    turnLifecycle: { state, turnId: 't1', ...(outcome ? { outcome } : {}) }
  })

it('reports no state for a session this host does not hold', () => {
  expect(readStructuredAgentSessionTurnState(sessions([]), 'other')).toBeNull()
})

const assistant = (sequence: number) => item(sequence, { kind: 'message', role: 'assistant' })

it('retains the exact running turn beyond a 200-item history page', () => {
  expect(
    readStructuredAgentSessionTurnState(
      sessions([
        user(1),
        lifecycle(2, 'running'),
        ...Array.from({ length: 201 }, (_, i) => assistant(i + 3))
      ]),
      'chat'
    )
  ).toEqual({
    activeTurnId: 't1',
    lifecycleKnown: true,
    running: true,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'unknown',
    lastSequence: 203
  })
})

it('reports a finished turn once the lifecycle row settles', () => {
  expect(
    readStructuredAgentSessionTurnState(
      sessions([user(1), lifecycle(2, 'running'), lifecycle(3, 'completed', 'completed')]),
      'chat'
    )
  ).toEqual({
    activeTurnId: null,
    lifecycleKnown: true,
    running: false,
    hasTurn: true,
    awaitingStart: false,
    outcome: 'completed',
    lastSequence: 3
  })
})

it('carries the settled outcome of an interrupted or failed turn', () => {
  expect(
    readStructuredAgentSessionTurnState(
      sessions([user(1), lifecycle(2, 'completed', 'interrupted')]),
      'chat'
    )
  ).toMatchObject({ running: false, outcome: 'interrupted' })
  expect(
    readStructuredAgentSessionTurnState(
      sessions([user(1), lifecycle(2, 'completed', 'failed')]),
      'chat'
    )
  ).toMatchObject({ outcome: 'failed' })
})

it('reads a settled row from an older host without an outcome as plain completion', () => {
  expect(
    readStructuredAgentSessionTurnState(sessions([user(1), lifecycle(2, 'completed')]), 'chat')
  ).toMatchObject({ outcome: 'completed' })
})

it('reports a just-submitted message as awaiting its turn before the running row lands', () => {
  expect(readStructuredAgentSessionTurnState(sessions([user(1)]), 'chat')).toMatchObject({
    running: false,
    hasTurn: true,
    awaitingStart: true
  })
  expect(
    readStructuredAgentSessionTurnState(
      sessions([user(1), lifecycle(2, 'running'), lifecycle(3, 'completed'), user(4)]),
      'chat'
    )
  ).toMatchObject({ running: false, awaitingStart: true })
})

it('settles a journal without lifecycle rows only once the assistant replied', () => {
  expect(
    readStructuredAgentSessionTurnState(sessions([user(1), assistant(2)]), 'chat')
  ).toMatchObject({ awaitingStart: false })
})

it('never infers completion from assistant text alone', () => {
  expect(
    readStructuredAgentSessionTurnState(sessions([user(1), assistant(2)]), 'chat')
  ).toMatchObject({ outcome: 'unknown' })
})

it('reports a fresh session with no turn yet', () => {
  expect(readStructuredAgentSessionTurnState(sessions([]), 'chat')).toEqual({
    activeTurnId: null,
    lifecycleKnown: false,
    running: false,
    hasTurn: false,
    awaitingStart: false,
    outcome: 'unknown',
    lastSequence: 0
  })
})
