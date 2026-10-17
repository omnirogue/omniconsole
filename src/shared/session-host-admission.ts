/**
 * The reference semantics of admission (docs/reference/session-host-control.md, "Single execution").
 * Package A calls this at the final guarded-write boundary with facts read atomically from the
 * host's durable journal, then persists the reservation and intent before any byte moves.
 * Operation-id dedupe alone is not enough: two Macs mint different ids for one idle turn.
 */

import { canonicalJson } from './decision-contracts/decision-calibration-summary'
import { sessionHostDigest, sessionHostTurnReservationKey } from './session-host-identity'
import { SESSION_HOST_ACTION_SPECS, type SessionHostRequest } from './session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from './session-host-refusal'

/** Everything that defines what an operation does; the same id with another fingerprint refuses. */
export function sessionHostRequestFingerprint(request: SessionHostRequest): string {
  return sessionHostDigest(
    canonicalJson([
      'session-host-request/v1',
      request.conversationId,
      request.expectedOwnerEpoch,
      request.expectedTurnRevision,
      request.expectedOrganizationRevision ?? null,
      request.reservation ?? null,
      request.origin,
      request.action,
      request.payload
    ])
  )
}

/** Read in one atomic step from the host's journal and registry. */
export type SessionHostAdmissionFacts = {
  /** False while the host reconciles its journal, process incarnations and queue after a restart. */
  admissionOpen: boolean
  /** The operation already recorded under this request's id. */
  existing: { fingerprint: string } | null
  /** This host's registry record for the conversation; null when it has none. */
  record: { ownerEpoch: number; owned: boolean; adopted: boolean } | null
  /** The turn the host reads now; null when it reads none. */
  turnRevision: string | null
  organizationRevision: string | null
  /** The operation whose reservation blocks the current turn (held, dispatched or unconfirmed). */
  turnHolder: { operationId: string } | null
}

export type SessionHostAdmissionDecision =
  /** Return the recorded operation unchanged: the host never runs one operation id twice. */
  | { kind: 'replay' }
  /** Persist `reservationKey` (null: nothing turn-fenced) with the intent, then dispatch. */
  | { kind: 'admit'; reservationKey: string | null }
  | { kind: 'refuse'; refusal: SessionHostRefusal }

const refuse = (...args: Parameters<typeof sessionHostRefusal>): SessionHostAdmissionDecision => ({
  kind: 'refuse',
  refusal: sessionHostRefusal(...args)
})

export function decideSessionHostAdmission(
  request: SessionHostRequest,
  fingerprint: string,
  facts: SessionHostAdmissionFacts
): SessionHostAdmissionDecision {
  if (facts.existing) {
    return facts.existing.fingerprint === fingerprint
      ? { kind: 'replay' }
      : refuse(
          'operation-conflict',
          'That operation id was already used for a different request. Nothing was changed.',
          { current: { operationId: request.operationId } }
        )
  }
  if (!facts.admissionOpen) {
    return refuse(
      'reconciling',
      'That computer restarted and is reconciling its sessions before it takes new actions. Nothing was changed.'
    )
  }
  const spec = SESSION_HOST_ACTION_SPECS[request.action]
  const { requester } = request.origin
  if (!spec.unattended && requester.kind !== 'person' && requester.unattended) {
    return refuse(
      'unattended-restricted',
      `Nobody is present, and ${request.action} needs a person to ask for it. It can be proposed, not done. Nothing was changed.`
    )
  }
  if (spec.fence === 'destination') {
    return facts.record && facts.record.ownerEpoch >= request.expectedOwnerEpoch
      ? refuse(
          'stale-owner-epoch',
          `This host already holds owner epoch ${facts.record.ownerEpoch} for that conversation. Nothing was changed.`,
          { current: { ownerEpoch: facts.record.ownerEpoch } }
        )
      : { kind: 'admit', reservationKey: null }
  }
  return decideOwnedAdmission(request, facts)
}

function decideOwnedAdmission(
  request: SessionHostRequest,
  facts: SessionHostAdmissionFacts
): SessionHostAdmissionDecision {
  const { record } = facts
  if (!record) {
    return refuse(
      'unknown-conversation',
      'That computer has no such conversation. Nothing was changed.'
    )
  }
  if (!record.adopted) {
    return refuse(
      'not-adopted',
      'That session predates host control and has not been adopted with verified ownership. Nothing was changed.'
    )
  }
  if (!record.owned) {
    return refuse(
      'not-owner',
      'That computer no longer runs this conversation. Nothing was changed.'
    )
  }
  if (record.ownerEpoch !== request.expectedOwnerEpoch) {
    return refuse(
      'stale-owner-epoch',
      'The conversation moved since it was read. Nothing was changed.',
      { current: { ownerEpoch: record.ownerEpoch } }
    )
  }
  const spec = SESSION_HOST_ACTION_SPECS[request.action]
  if (spec.feature === 'organization' && facts.organizationRevision !== null) {
    if (request.expectedOrganizationRevision !== facts.organizationRevision) {
      return refuse(
        'stale-organization-revision',
        'Its folder, title or archive state changed since it was read, so this was not applied over it. Nothing was changed.',
        { current: { organizationRevision: facts.organizationRevision } }
      )
    }
  }
  if (spec.fence !== 'turn') {
    return { kind: 'admit', reservationKey: null }
  }
  return decideTurnAdmission(request, facts, record.ownerEpoch)
}

function decideTurnAdmission(
  request: SessionHostRequest,
  facts: SessionHostAdmissionFacts,
  ownerEpoch: number
): SessionHostAdmissionDecision {
  if (facts.turnRevision === null) {
    return refuse(
      'turn-unknown',
      'That computer cannot read the conversation’s current turn, so nothing can be reserved against it. Nothing was changed.',
      { current: { turnRevision: null } }
    )
  }
  if (request.expectedTurnRevision !== facts.turnRevision) {
    return refuse(
      'stale-turn',
      'The conversation moved on since it was read. Nothing was changed.',
      { current: { turnRevision: facts.turnRevision } }
    )
  }
  const holder = facts.turnHolder?.operationId
  if (request.reservation !== undefined && request.reservation !== holder) {
    return refuse(
      'reservation-invalid',
      'The reservation this step names no longer holds the conversation. Nothing was changed.',
      holder ? { current: { operationId: holder } } : {}
    )
  }
  if (holder !== undefined && holder !== request.reservation) {
    return refuse(
      'turn-reserved',
      'Another request already holds this turn of the conversation, so this one was not admitted. Nothing was changed.',
      { current: { operationId: holder } }
    )
  }
  return {
    kind: 'admit',
    reservationKey: sessionHostTurnReservationKey(
      request.conversationId,
      ownerEpoch,
      facts.turnRevision
    )
  }
}
