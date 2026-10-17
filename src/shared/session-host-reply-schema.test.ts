import { describe, expect, it } from 'vitest'
import type {
  SessionHostExecuteResult,
  SessionHostObserveResult,
  SessionHostOperationResult,
  SessionHostWaitStatusResult
} from './session-host-protocol'
import {
  SessionHostExecuteReplySchema,
  SessionHostObserveReplySchema,
  SessionHostOperationReplySchema,
  SessionHostWaitStatusReplySchema,
  readSessionHostReply
} from './session-host-reply-schema'
import { SESSION_HOST_EXECUTION_VERDICTS, sessionHostVerdictOf } from './session-host-verdict'
import { sessionHostRetryRule } from './session-host-refusal'
import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_HOST,
  FIXTURE_NOW,
  FIXTURE_OTHER_CONVERSATION_ID,
  fixtureOperationId
} from './session-host-wire-fixtures'

const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value))

const observation = {
  conversationId: FIXTURE_CONVERSATION_ID,
  ownerEpoch: 1,
  turnRevision: 'turn:7f3a',
  organizationRevision: 'org:12',
  verdict: 'live' as const,
  admission: 'open' as const,
  provider: { agent: 'claude', sessionId: 'sess-1' },
  ref: {
    hostId: FIXTURE_HOST.hostId,
    conversationId: FIXTURE_CONVERSATION_ID,
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreePath: '/work/app'
  }
}

const observe: SessionHostObserveResult = {
  status: 'ok',
  host: FIXTURE_HOST,
  observedAt: FIXTURE_NOW,
  complete: true,
  sessions: [observation]
}

const operation = {
  operationId: fixtureOperationId(1),
  conversationId: FIXTURE_CONVERSATION_ID,
  action: 'continue' as const,
  state: 'completed' as const,
  fingerprint: `sha256:${'d'.repeat(64)}`,
  host: FIXTURE_HOST,
  ownerEpoch: 1,
  turnRevision: 'turn:7f3a',
  admittedAt: FIXTURE_NOW,
  settledAt: FIXTURE_NOW + 5,
  result: { summary: 'Sent.' },
  verdict: 'live' as const
}

describe('session host replies, as a client reads them', () => {
  it('round-trips what a current host authors', () => {
    const execute: SessionHostExecuteResult = { status: 'ok', operation }
    const found: SessionHostOperationResult = { status: 'ok', found: true, operation }
    const missing: SessionHostOperationResult = { status: 'ok', found: false, host: FIXTURE_HOST }
    const wait: SessionHostWaitStatusResult = {
      status: 'ok',
      receipt: {
        registration: fixtureOperationId(19),
        dependency: FIXTURE_CONVERSATION_ID,
        state: 'satisfied',
        satisfiedBy: { ownerEpoch: 1, outcomeRevision: 'outcome:3', at: FIXTURE_NOW }
      }
    }
    expect(SessionHostObserveReplySchema.parse(wire(observe))).toEqual(observe)
    expect(SessionHostExecuteReplySchema.parse(wire(execute))).toEqual(execute)
    expect(SessionHostOperationReplySchema.parse(wire(found))).toEqual(found)
    expect(SessionHostOperationReplySchema.parse(wire(missing))).toEqual(missing)
    expect(SessionHostWaitStatusReplySchema.parse(wire(wait))).toEqual(wait)
  })

  it('drops fields a newer host adds (old client, new host)', () => {
    const newer = { ...observe, shardCount: 4, sessions: [{ ...observation, driverLease: 'x' }] }
    expect(SessionHostObserveReplySchema.parse(wire(newer))).toEqual(observe)
  })

  it('reads any verdict outside the three as unverifiable, never as a synonym', () => {
    expect(SESSION_HOST_EXECUTION_VERDICTS).toEqual(['live', 'unverifiable', 'exited'])
    for (const verdict of [
      'dead',
      'stopped',
      'offline',
      'unknown',
      'running',
      'gone',
      'EXITED',
      null,
      3
    ]) {
      const reply = SessionHostObserveReplySchema.parse(
        wire({ ...observe, sessions: [{ ...observation, verdict }] })
      )
      expect(reply.status === 'ok' && reply.sessions[0]?.verdict).toBe('unverifiable')
    }
  })

  it('degrades unknown states to the reading that asserts least', () => {
    const reply = SessionHostExecuteReplySchema.parse(
      wire({ status: 'ok', operation: { ...operation, state: 'delivered' } })
    )
    expect(reply.status === 'ok' && reply.operation.state).toBe('unconfirmed')
    const admission = SessionHostObserveReplySchema.parse(
      wire({ ...observe, sessions: [{ ...observation, admission: 'leased' }] })
    )
    expect(admission.status === 'ok' && admission.sessions[0]?.admission).toBe('disabled')
    const wait = SessionHostWaitStatusReplySchema.parse(
      wire({
        status: 'ok',
        receipt: {
          registration: fixtureOperationId(19),
          dependency: FIXTURE_CONVERSATION_ID,
          state: 'fulfilled'
        }
      })
    )
    expect(wait.status === 'ok' && wait.receipt.state).toBe('registered')
  })

  it('keeps a newer host’s refusal code as a string with its message', () => {
    const refused = {
      status: 'refused',
      refusal: { code: 'quota-lease-held', message: 'Held by a lease.' }
    }
    expect(SessionHostExecuteReplySchema.parse(wire(refused))).toEqual(refused)
    expect(sessionHostRetryRule('quota-lease-held')).toBe('never')
  })

  it('drops an unreadable row and marks the listing incomplete', () => {
    const reply = SessionHostObserveReplySchema.parse(
      wire({ ...observe, sessions: [observation, { ...observation, conversationId: 'nope' }] })
    )
    expect(reply).toEqual({ ...observe, complete: false })
  })

  it('treats an unreadable reply as no answer: unknown outcome, never resent', () => {
    const result = readSessionHostReply(SessionHostExecuteReplySchema, {
      status: 'ok',
      operation: 'x'
    })
    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({ code: 'host-unreachable' })
    })
    expect(result.ok ? null : sessionHostRetryRule(result.refusal.code)).toBe(
      'repeat-same-operation'
    )
  })
})

describe('sessionHostVerdictOf', () => {
  it('says live or exited only from the owning host’s own observation', () => {
    const exited = { ...observe, sessions: [{ ...observation, verdict: 'exited' as const }] }
    expect(sessionHostVerdictOf(observe, FIXTURE_CONVERSATION_ID)).toBe('live')
    expect(sessionHostVerdictOf(exited, FIXTURE_CONVERSATION_ID)).toBe('exited')
  })

  it('is unverifiable for a lost reply, a refusal, or a conversation the host did not list', () => {
    expect(sessionHostVerdictOf(null, FIXTURE_CONVERSATION_ID)).toBe('unverifiable')
    expect(sessionHostVerdictOf(undefined, FIXTURE_CONVERSATION_ID)).toBe('unverifiable')
    const refused = { status: 'refused', refusal: { code: 'reconciling', message: 'x' } }
    expect(sessionHostVerdictOf(refused, FIXTURE_CONVERSATION_ID)).toBe('unverifiable')
    expect(sessionHostVerdictOf(observe, FIXTURE_OTHER_CONVERSATION_ID)).toBe('unverifiable')
  })
})
