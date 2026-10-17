import { describe, expect, it } from 'vitest'
import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'
import { evaluateAgentSessionOperation } from './agent-session-operation-ledger'
import {
  CONVERSATION_DELIVERY_SENDERS,
  conversationDeliveryOperationId
} from './conversation-source'

// Measured 2026-09-20: `prompt-queue:<uuid>` ids were refused by the structured door's ledger
// (`agent_session_operation_invalid`) before any byte moved, so every Up-next prompt queued to a
// native chat conversation failed. The id must be the shape the ledger parses.
describe('conversationDeliveryOperationId', () => {
  const uuid = '8ef5fa5d-57dc-415a-be20-c983fae27a28'
  const now = 1_789_935_000_000

  it.each(CONVERSATION_DELIVERY_SENDERS)('mints a ledger-parseable id for sender %s', (sender) => {
    const id = conversationDeliveryOperationId(sender, uuid, now)
    expect(id).toBe('1789935000000-8ef5fa5d57dc415abe20c983fae27a28')
    expect(parseAgentSessionOperationTimestamp(id)).toBe(now)
  })

  it('is admitted as a fresh operation by the structured ledger', () => {
    const id = conversationDeliveryOperationId('prompt-queue', uuid, now)
    const decision = evaluateAgentSessionOperation({
      rows: new Map(),
      callerKey: 'conversation-delivery',
      operationId: id,
      fingerprint: 'fp',
      now: now + 1_000
    })
    expect(decision.decision).toBe('admit')
  })

  it('refuses to mint from a unique that is not 32 hex characters', () => {
    expect(() => conversationDeliveryOperationId('up-next', 'abc', now)).toThrow(
      'Unable to create a durable delivery operation id'
    )
  })
})
