/**
 * Reads `decideSessionHostAdmission`'s facts from a journal snapshot taken under the writer lock.
 *
 * A reservation that is held, dispatching or unconfirmed holds the whole conversation, whatever its
 * turn: a freeze or an unknowable delivery must fence every later turn until it is released or
 * reconciled. A settled one keeps its own turn consumed: a delivered prompt may not have moved the
 * turn yet, and a second Mac echoing the same revision must still lose. A settled archive consumed
 * nothing (it never moves the turn), so it must not refuse every later continue on that turn.
 */

import type { SessionHostAdmissionFacts } from '../../shared/session-host-admission'
import {
  sessionHostReservationBlocks,
  sessionHostTurnReservationKey
} from '../../shared/session-host-identity'
import {
  sessionHostActionConsumesTurn,
  type SessionHostAdmissionStatus,
  type SessionHostFence,
  type SessionHostRequest
} from '../../shared/session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostJournal,
  SessionHostJournalReservation,
  SessionHostRegistration
} from './session-host-journal'

/** What the executor read live, inside the lock; `unreadable` when it could not answer. */
export type SessionHostTurnReading =
  | { turnRevision: string | null; organizationRevision: string | null }
  | 'unreadable'

export function sessionHostConversationHolder(
  journal: SessionHostJournal,
  registration: SessionHostRegistration,
  turnRevision: string | null
): SessionHostJournalReservation | null {
  const mine = Object.values(journal.reservations).filter(
    (reservation) =>
      reservation.conversationId === registration.conversationId &&
      reservation.ownerEpoch === registration.ownerEpoch
  )
  const active = mine
    .filter((reservation) => sessionHostReservationBlocks(reservation.state))
    .sort((a, b) => a.heldAt - b.heldAt)[0]
  if (active) {
    return active
  }
  if (turnRevision === null) {
    return null
  }
  const key = sessionHostTurnReservationKey(
    registration.conversationId,
    registration.ownerEpoch,
    turnRevision
  )
  return (
    mine.find(
      (reservation) =>
        reservation.key === key &&
        reservation.state === 'settled' &&
        sessionHostActionConsumesTurn(reservation.action)
    ) ?? null
  )
}

export function sessionHostAdmissionFacts(input: {
  journal: SessionHostJournal
  request: SessionHostRequest
  fingerprint: string | null
  registration: SessionHostRegistration | null
  reading: Exclude<SessionHostTurnReading, 'unreadable'>
  admissionOpen: boolean
}): SessionHostAdmissionFacts {
  const { journal, registration, reading } = input
  const existing = journal.operations[input.request.operationId]
  const holder = registration
    ? sessionHostConversationHolder(journal, registration, reading.turnRevision)
    : null
  return {
    admissionOpen: input.admissionOpen,
    existing: existing ? { fingerprint: existing.fingerprint } : null,
    record: registration
      ? {
          ownerEpoch: registration.ownerEpoch,
          owned: registration.owned,
          adopted: registration.adopted
        }
      : null,
    turnRevision: reading.turnRevision,
    organizationRevision: reading.organizationRevision,
    turnHolder: holder ? { operationId: holder.operationId } : null
  }
}

/**
 * Checked before the reference decision (a replay still wins): the conversation must be run by THIS
 * host process. Another live process on the account refuses; a dead one's conversations wait for
 * the restarted process to take them back after reconciliation.
 */
export function sessionHostControllerRefusal(input: {
  journal: SessionHostJournal
  /** Null for a destination step, which runs where no owned record exists yet. */
  registration: SessionHostRegistration | null
  controller: string
}): SessionHostRefusal | null {
  const { journal, registration } = input
  if (!registration?.owned || registration.controller === input.controller) {
    return null
  }
  return registration.controller !== null && registration.controller in journal.controllers
    ? sessionHostRefusal(
        'ownership-conflict',
        'Another OmniConsole process on that computer runs this conversation, so this one cannot act on it. Nothing was changed.'
      )
    : sessionHostRefusal(
        'reconciling',
        'The process that ran this conversation on that computer has stopped; it is reconciled before new actions are taken. Nothing was changed.'
      )
}

/** Checked after an `admit`: only a reservation's holder may run under it, one step at a time. */
export function sessionHostReservationRefusal(input: {
  journal: SessionHostJournal
  request: SessionHostRequest
  fence: SessionHostFence
  holder: string
}): SessionHostRefusal | null {
  const { request } = input
  if (request.reservation === undefined) {
    return null
  }
  if (input.fence !== 'turn') {
    return sessionHostRefusal(
      'reservation-invalid',
      `${request.action} does not run under a reservation. Nothing was changed.`
    )
  }
  const reservation = input.journal.reservations[request.reservation]
  return !reservation || reservation.holder !== input.holder || reservation.running
    ? sessionHostRefusal(
        'reservation-invalid',
        'The reservation this step names is held by someone else or is busy. Nothing was changed.',
        { current: { operationId: request.reservation } }
      )
    : null
}

/** How observe describes a conversation's admission right now. */
export function sessionHostObservedAdmission(input: {
  journal: SessionHostJournal
  registration: SessionHostRegistration
  turnRevision: string | null
  admissionOpen: boolean
  controller: string
  automationDisabled: boolean
}): { status: SessionHostAdmissionStatus; holder: SessionHostJournalReservation | null } {
  const { journal, registration } = input
  const holder = sessionHostConversationHolder(journal, registration, input.turnRevision)
  const controller = registration.controller
  const otherLiveController =
    controller !== input.controller && controller !== null && controller in journal.controllers
  if (!input.admissionOpen || (controller !== input.controller && !otherLiveController)) {
    return { status: 'reconciling', holder }
  }
  if (!registration.adopted) {
    return { status: 'not-adopted', holder }
  }
  // Why disabled: another live process on this host runs it, so this connection cannot act on it.
  if (input.automationDisabled || otherLiveController) {
    return { status: 'disabled', holder }
  }
  return { status: holder ? 'reserved' : 'open', holder }
}
