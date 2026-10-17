import { describe, expect, it } from 'vitest'
import { agentJournalItemKey, agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentJournalTurnSettlement
} from './agent-session-journal-types'
import { observeStructuredAgentSessionOutcome } from './structured-agent-session-outcome-observation'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemsToNativeChat
} from './structured-agent-session-projection'

const RECEIPT = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread:source',
  turnId: 'turn-1',
  ordinal: 0
})
const SUBMISSION: AgentJournalSubmission = {
  clientMessageId: 'message-1',
  fence: 3,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'accepted',
  providerItemId: RECEIPT,
  reason: null,
  submittedAt: 100,
  resolvedAt: 110
}

function completed(
  outcome: AgentJournalTurnSettlement['outcome'] = 'succeeded',
  providerItemId = RECEIPT
): AgentJournalItemBody {
  return {
    kind: 'status',
    text: '',
    turnLifecycle: {
      turnId: 'turn-1',
      state: 'completed',
      settlement: { providerItemId, outcome }
    }
  }
}

function snapshot(
  bodies: AgentJournalItemBody[] = [completed()],
  submissions = [SUBMISSION]
): AgentJournalSnapshot {
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: 10 },
    submissions,
    items: bodies.map((body, index) => ({
      itemId: `item-${index}`,
      revision: 1,
      sequence: index + 1,
      observedAt: index + 120,
      body
    }))
  }
}

describe('structured source outcome observation', () => {
  it('uses the exact admitted native receipt and keeps its version stable across later notes', () => {
    const original = observeStructuredAgentSessionOutcome(snapshot())
    expect(original).toMatchObject({ ready: true, version: expect.any(String) })
    const later = snapshot([completed(), { kind: 'status', text: 'Saved a note' }])
    later.cursor.sequence = 999
    expect(observeStructuredAgentSessionOutcome(later)).toEqual(original)
    expect(
      observeStructuredAgentSessionOutcome(
        snapshot([completed()], [{ ...SUBMISSION, clientMessageId: 'another-submission' }])
      ).version
    ).not.toBe(original.version)
  })

  it.each(['pending', 'unknown', 'rejected'] as const)(
    'does not advance a newer %s send using an earlier successful turn',
    (dispatchState) => {
      const latest = {
        ...SUBMISSION,
        clientMessageId: 'message-2',
        dispatchState,
        providerItemId: null,
        submittedAt: 200
      }
      expect(
        observeStructuredAgentSessionOutcome(snapshot([completed()], [SUBMISSION, latest]))
      ).toMatchObject({ ready: false })
    }
  )

  it('does not transfer completion between receipts or sessions without a submitted turn', () => {
    expect(
      observeStructuredAgentSessionOutcome(snapshot([completed('succeeded', 'another-receipt')]))
    ).toMatchObject({ ready: false, unverifiable: true })
    expect(observeStructuredAgentSessionOutcome(snapshot([completed()], []))).toEqual({
      ready: false,
      reason: 'The source session has no submitted turn.'
    })
  })

  it.each(['failed', 'cancelled', 'unknown'] as const)(
    'does not treat %s settlement as success',
    (outcome) => {
      expect(observeStructuredAgentSessionOutcome(snapshot([completed(outcome)]))).toMatchObject({
        ready: false
      })
    }
  )

  it('never takes completed chrome, assistant prose, or an absent working row as proof', () => {
    for (const bodies of [
      [],
      [{ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Task completed.' }] }],
      [{ kind: 'status', text: 'Provider exited successfully.' }],
      [{ kind: 'status', text: '', turnLifecycle: { turnId: 'turn-1', state: 'completed' } }]
    ] satisfies AgentJournalItemBody[][]) {
      expect(observeStructuredAgentSessionOutcome(snapshot(bodies))).toMatchObject({
        ready: false,
        unverifiable: true
      })
    }
  })

  it('keeps a newer active turn visible when an older turn completes late', () => {
    const state = snapshot([
      { kind: 'status', text: '', turnLifecycle: { turnId: 'turn-2', state: 'running' } },
      completed()
    ])
    expect(activeStructuredAgentSessionTurnId(state.items)).toBe('turn-2')
    expect(observeStructuredAgentSessionOutcome(state)).toEqual({ ready: false })
    expect(
      activeStructuredAgentSessionTurnId(
        snapshot([
          { kind: 'status', text: '', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
          completed()
        ]).items
      )
    ).toBeNull()
  })

  it.each(['question', 'approval'] as const)('keeps a pending %s visible after success', (kind) => {
    const resolution = {
      state: 'pending' as const,
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
    const prompt: AgentJournalItemBody =
      kind === 'question'
        ? { kind, question: 'Which person?', options: [], resolution }
        : { kind, title: 'Permission needed', detail: null, options: [], resolution }
    expect(observeStructuredAgentSessionOutcome(snapshot([completed(), prompt]))).toEqual({
      ready: false,
      reason: 'The source agent needs your input.'
    })
  })

  it('keeps additive settlement metadata deeply validated and out of transcript prose', () => {
    const body = completed()
    expect(isAdmissibleAgentJournalItemBody(body)).toBe(true)
    expect(projectStructuredItemsToNativeChat(snapshot([body]).items)).toEqual([])
    expect(
      isAdmissibleAgentJournalItemBody({
        kind: 'status',
        text: '',
        turnLifecycle: { turnId: 'turn-1', state: 'completed', settlement: true }
      })
    ).toBe(false)
    expect(
      observeStructuredAgentSessionOutcome(
        snapshot([completed('future-result' as AgentJournalTurnSettlement['outcome'])])
      )
    ).toMatchObject({ ready: false, unverifiable: true })
  })

  it('does not turn stopped or cancelled pending input into successful completion', () => {
    const cancelled: AgentJournalItemBody = {
      kind: 'question',
      question: 'Which destination?',
      options: [],
      resolution: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: 200 }
    }
    expect(observeStructuredAgentSessionOutcome(snapshot([completed(), cancelled]))).toEqual({
      ready: false,
      reason: 'The source turn ended with cancelled input.'
    })
    const user: AgentJournalItemBody = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue without that step' }]
    }
    const later = snapshot([cancelled, user, completed()])
    later.items[1]!.itemId = agentJournalSubmissionKey(SUBMISSION.clientMessageId)
    expect(observeStructuredAgentSessionOutcome(later).ready).toBe(true)
  })
})
