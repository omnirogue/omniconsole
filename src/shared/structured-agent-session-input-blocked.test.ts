import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import type {
  AgentJournalItemBody,
  AgentJournalSnapshot,
  AgentJournalStatusItem
} from './agent-session-journal-types'
import { observeStructuredAgentSessionOutcome } from './structured-agent-session-outcome-observation'

const RECEIPT = 'codex:root:turn-1:0'
const USER: AgentJournalItemBody = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Finish the requested work.' }]
}
const SUCCESS: AgentJournalStatusItem = {
  kind: 'status',
  text: '',
  turnLifecycle: {
    turnId: 'turn-1',
    state: 'completed',
    settlement: { providerItemId: RECEIPT, outcome: 'succeeded' }
  }
}

function blocked(providerItemId: string | null = RECEIPT): AgentJournalStatusItem {
  return {
    kind: 'status',
    text: 'Input could not be provided.',
    inputBlocked: { providerItemId, reason: 'provider-request-declined' }
  }
}

function snapshot(bodies: AgentJournalItemBody[]): AgentJournalSnapshot {
  return {
    sessionId: 'source',
    cursor: { epoch: 'epoch-1', sequence: 20 },
    submissions: [
      {
        clientMessageId: 'latest',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: RECEIPT,
        reason: null,
        submittedAt: 10,
        resolvedAt: 11
      }
    ],
    items: bodies.map((body, index) => ({
      itemId: body === USER ? agentJournalSubmissionKey('latest') : `item-${index}`,
      revision: 1,
      body,
      sequence: index + 1,
      observedAt: 10 + index
    }))
  }
}

describe('unanswered native provider input', () => {
  it('keeps receipt-bound input blocked despite a later successful turn result', () => {
    expect(observeStructuredAgentSessionOutcome(snapshot([USER, blocked(), SUCCESS]))).toEqual({
      ready: false,
      reason: 'The source turn ended with an unanswered input request.'
    })
    expect(observeStructuredAgentSessionOutcome(snapshot([blocked(), SUCCESS])).ready).toBe(false)
  })

  it('scopes unknown-turn input to the latest submission sequence', () => {
    expect(
      observeStructuredAgentSessionOutcome(snapshot([USER, blocked(null), SUCCESS])).ready
    ).toBe(false)
    expect(
      observeStructuredAgentSessionOutcome(snapshot([blocked(null), USER, SUCCESS])).ready
    ).toBe(true)
    expect(observeStructuredAgentSessionOutcome(snapshot([blocked(null), SUCCESS])).ready).toBe(
      false
    )
  })

  it('allows a new receipt to finish independently of known input blocked on another turn', () => {
    expect(
      observeStructuredAgentSessionOutcome(
        snapshot([USER, blocked('codex:root:older-turn:0'), SUCCESS])
      ).ready
    ).toBe(true)
  })

  it('does not read ordinary status prose or generic frame content as authority', () => {
    const prose = { kind: 'status' as const, text: 'Input could not be provided.' }
    const generic = {
      ...prose,
      providerFrame: {
        provider: 'codex',
        kind: 'request:mcpServer/elicitation/request',
        payload: {
          head: '{"action":"decline"}',
          byteLength: 20,
          digest: 'digest',
          truncated: false
        }
      }
    }
    expect(
      observeStructuredAgentSessionOutcome(snapshot([USER, prose, generic, SUCCESS])).ready
    ).toBe(true)
  })

  it('admits additive typed metadata and rejects malformed authority fields', () => {
    expect(isAdmissibleAgentJournalItemBody(blocked())).toBe(true)
    expect(isAdmissibleAgentJournalItemBody(blocked(null))).toBe(true)
    for (const inputBlocked of [
      true,
      { providerItemId: null },
      { providerItemId: 5, reason: 'provider-request-declined' },
      { providerItemId: RECEIPT, reason: false }
    ]) {
      expect(isAdmissibleAgentJournalItemBody({ kind: 'status', text: '', inputBlocked })).toBe(
        false
      )
    }
  })
})
