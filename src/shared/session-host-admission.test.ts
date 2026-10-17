import { describe, expect, it } from 'vitest'
import {
  decideSessionHostAdmission,
  sessionHostRequestFingerprint,
  type SessionHostAdmissionFacts
} from './session-host-admission'
import {
  sessionHostGrantMismatch,
  sessionHostReservationBlocks,
  sessionHostTurnReservationKey,
  type SessionHostOwnershipGrant
} from './session-host-identity'
import type { SessionHostRequest } from './session-host-protocol'
import { sessionHostRetryRule } from './session-host-refusal'
import { SESSION_HOST_REQUEST_FIXTURES } from './session-host-request-fixtures'
import { SessionHostRequestSchema } from './session-host-schema'
import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_HOST,
  FIXTURE_OTHER_HOST_ID,
  fixtureOperationId
} from './session-host-wire-fixtures'

const fixtures = SESSION_HOST_REQUEST_FIXTURES
const facts = (patch: Partial<SessionHostAdmissionFacts> = {}): SessionHostAdmissionFacts => ({
  admissionOpen: true,
  existing: null,
  record: { ownerEpoch: 1, owned: true, adopted: true },
  turnRevision: 'turn:7f3a',
  organizationRevision: 'org:12',
  turnHolder: null,
  ...patch
})
const decide = (request: SessionHostRequest, patch: Partial<SessionHostAdmissionFacts> = {}) =>
  decideSessionHostAdmission(request, sessionHostRequestFingerprint(request), facts(patch))
const code = (decision: ReturnType<typeof decide>) =>
  decision.kind === 'refuse' ? decision.refusal.code : decision.kind

describe('sessionHostRequestFingerprint', () => {
  it('ignores key order and transport, and changes with anything that changes the action', () => {
    const ask = fixtures.ask
    const reordered = {
      ...ask,
      payload: { timeoutMs: ask.payload.timeoutMs, question: ask.payload.question }
    }
    expect(Object.keys(reordered.payload)).not.toEqual(Object.keys(ask.payload))
    expect(sessionHostRequestFingerprint(reordered)).toBe(sessionHostRequestFingerprint(ask))
    const request = fixtures.continue
    const overTheWire = SessionHostRequestSchema.parse(JSON.parse(JSON.stringify(request)))
    expect(sessionHostRequestFingerprint(overTheWire)).toBe(sessionHostRequestFingerprint(request))
    const edited = {
      ...request,
      payload: { answer: { kind: 'prompt' as const, text: 'Stop instead.' } }
    }
    expect(sessionHostRequestFingerprint(edited)).not.toBe(sessionHostRequestFingerprint(request))
    expect(sessionHostRequestFingerprint({ ...request, expectedTurnRevision: 'turn:8' })).not.toBe(
      sessionHostRequestFingerprint(request)
    )
  })
})

describe('decideSessionHostAdmission', () => {
  it('returns the recorded outcome for a duplicate id and refuses it with a changed payload', () => {
    const request = fixtures.continue
    const fingerprint = sessionHostRequestFingerprint(request)
    expect(decide(request, { existing: { fingerprint } })).toEqual({ kind: 'replay' })
    // Even while reconciling or after the turn moved on: a recorded id is answered, never re-run.
    expect(
      decide(request, { existing: { fingerprint }, admissionOpen: false, turnRevision: 'turn:9' })
    ).toEqual({
      kind: 'replay'
    })
    expect(code(decide(request, { existing: { fingerprint: `sha256:${'0'.repeat(64)}` } }))).toBe(
      'operation-conflict'
    )
  })

  it('admits one of two Macs’ different ids for the same turn, whatever the interleaving', () => {
    const first = fixtures.continue
    const second = {
      ...first,
      operationId: fixtureOperationId(50),
      origin: { ...first.origin, computer: 'Laptop' }
    }
    for (const order of [
      [first, second],
      [second, first]
    ]) {
      // A tiny journal: the reservation is recorded atomically with admission.
      let holder: { operationId: string } | null = null
      const admitted = order.filter((request) => {
        const decision = decide(request, { turnHolder: holder })
        if (decision.kind === 'admit') {
          holder = { operationId: request.operationId }
        }
        return decision.kind === 'admit'
      })
      expect(admitted).toHaveLength(1)
      const loser = order[1]!
      expect(decide(loser, { turnHolder: holder })).toMatchObject({
        kind: 'refuse',
        refusal: { code: 'turn-reserved', current: { operationId: order[0]!.operationId } }
      })
    }
  })

  it('reserves the turn itself, keyed by conversation, epoch and turn', () => {
    expect(decide(fixtures.continue)).toEqual({
      kind: 'admit',
      reservationKey: sessionHostTurnReservationKey(FIXTURE_CONVERSATION_ID, 1, 'turn:7f3a')
    })
    expect(sessionHostTurnReservationKey(FIXTURE_CONVERSATION_ID, 2, 'turn:7f3a')).not.toBe(
      sessionHostTurnReservationKey(FIXTURE_CONVERSATION_ID, 1, 'turn:7f3a')
    )
  })

  it('lets a step run under its own reservation and refuses one that names a lost reservation', () => {
    const exported = fixtures['relocate.export']
    expect(decide(exported, { turnHolder: { operationId: fixtureOperationId(14) } }).kind).toBe(
      'admit'
    )
    expect(code(decide(exported, { turnHolder: null }))).toBe('reservation-invalid')
    expect(code(decide(exported, { turnHolder: { operationId: fixtureOperationId(99) } }))).toBe(
      'reservation-invalid'
    )
  })

  it('refuses in the order that tells the caller the most', () => {
    const request = fixtures.continue
    expect(code(decide(request, { admissionOpen: false }))).toBe('reconciling')
    expect(code(decide(request, { record: null }))).toBe('unknown-conversation')
    expect(code(decide(request, { record: { ownerEpoch: 1, owned: true, adopted: false } }))).toBe(
      'not-adopted'
    )
    expect(code(decide(request, { record: { ownerEpoch: 2, owned: false, adopted: true } }))).toBe(
      'not-owner'
    )
    expect(
      decide(request, { record: { ownerEpoch: 3, owned: true, adopted: true } })
    ).toMatchObject({
      refusal: { code: 'stale-owner-epoch', current: { ownerEpoch: 3 } }
    })
    expect(code(decide(request, { turnRevision: null }))).toBe('turn-unknown')
    expect(decide(request, { turnRevision: 'turn:8' })).toMatchObject({
      refusal: { code: 'stale-turn', current: { turnRevision: 'turn:8' } }
    })
  })

  it('lets a stop through while a continuation holds the turn', () => {
    expect(
      decide(fixtures.stop, {
        turnHolder: { operationId: fixtureOperationId(1) },
        turnRevision: null
      }).kind
    ).toBe('admit')
  })

  it('checks organization changes against the revision the caller saw', () => {
    expect(decide(fixtures.rename)).toEqual({ kind: 'admit', reservationKey: null })
    expect(code(decide(fixtures.rename, { organizationRevision: 'org:13' }))).toBe(
      'stale-organization-revision'
    )
    const { expectedOrganizationRevision: _seen, ...blind } = fixtures.rename
    expect(code(decide(blind))).toBe('stale-organization-revision')
    expect(decide(blind, { organizationRevision: null }).kind).toBe('admit')
    // An archive is also turn-fenced: it never races a continuation.
    expect(
      code(decide(fixtures.archive, { turnHolder: { operationId: fixtureOperationId(1) } }))
    ).toBe('turn-reserved')
  })

  it('refuses relocation and transfers to anything unattended, before any policy', () => {
    const unattended = {
      kind: 'pane' as const,
      paneKey: 'p',
      title: 'Cleanup',
      unattended: { source: 'cleanup-run' as const }
    }
    for (const request of [
      fixtures['relocate.freeze-source'],
      fixtures['relocate.resume'],
      fixtures['transfer.prepare-source']
    ]) {
      expect(
        code(decide({ ...request, origin: { ...request.origin, requester: unattended } }))
      ).toBe('unattended-restricted')
    }
    const nudge = {
      ...fixtures.continue,
      origin: { ...fixtures.continue.origin, requester: unattended }
    }
    expect(decide(nudge).kind).toBe('admit')
  })

  it('admits a relocation destination only for an epoch it has not reached', () => {
    const resume = fixtures['relocate.resume']
    expect(decide(resume, { record: null, turnRevision: null }).kind).toBe('admit')
    expect(code(decide(resume, { record: { ownerEpoch: 2, owned: true, adopted: true } }))).toBe(
      'stale-owner-epoch'
    )
  })
})

describe('reservations and grants', () => {
  it('keeps an unconfirmed reservation blocking until it is reconciled', () => {
    expect(sessionHostReservationBlocks('held')).toBe(true)
    expect(sessionHostReservationBlocks('dispatched')).toBe(true)
    expect(sessionHostReservationBlocks('unconfirmed')).toBe(true)
    expect(sessionHostReservationBlocks('settled')).toBe(false)
    expect(sessionHostReservationBlocks('released')).toBe(false)
  })

  it('accepts a grant only at the destination it names, for an epoch it has not seen', () => {
    const grant = fixtures['relocate.resume'].payload.grant as SessionHostOwnershipGrant
    const consumer = {
      hostId: FIXTURE_HOST.hostId,
      conversationId: FIXTURE_CONVERSATION_ID,
      knownEpoch: null
    }
    expect(sessionHostGrantMismatch(grant, consumer)).toBeNull()
    expect(
      sessionHostGrantMismatch(grant, { ...consumer, hostId: FIXTURE_OTHER_HOST_ID })
    ).toContain('destination')
    expect(sessionHostGrantMismatch(grant, { ...consumer, knownEpoch: 2 })).toContain(
      'already knows epoch 2'
    )
    expect(sessionHostGrantMismatch({ ...grant, ownerEpoch: 1 }, consumer)).toContain('advances')
    expect(sessionHostGrantMismatch({ ...grant, fromHostId: grant.toHostId }, consumer)).toContain(
      'already owns'
    )
  })

  it('tells callers how to retry each refusal', () => {
    expect(sessionHostRetryRule('host-unreachable')).toBe('repeat-same-operation')
    expect(sessionHostRetryRule('renegotiate')).toBe('repeat-same-operation')
    expect(sessionHostRetryRule('turn-reserved')).toBe('new-operation-after-observe')
    expect(sessionHostRetryRule('stale-turn')).toBe('new-operation-after-observe')
    expect(sessionHostRetryRule('hard-stop')).toBe('never')
    expect(sessionHostRetryRule('operation-conflict')).toBe('never')
  })
})
