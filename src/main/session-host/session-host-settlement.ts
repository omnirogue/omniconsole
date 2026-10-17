/**
 * How an operation and the reservation it holds (or runs under) end. Shared by live settlement,
 * restart reconciliation and explicit reconciliation, so all three leave identical records.
 */

import {
  SESSION_HOST_ACTION_SPECS,
  sessionHostActionConsumesTurn
} from '../../shared/session-host-protocol'
import type { SessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionExecutionVerdict } from '../../shared/session-host-verdict'
import type { SessionHostJournal, SessionHostJournalOperation } from './session-host-journal'

/** What a dispatch proved. `not-delivered` is only for a refusal before any byte moved. */
export type SessionHostSettlement =
  | {
      kind: 'completed'
      result?: unknown
      verdict?: SessionExecutionVerdict
      /** What happens to the reservation; transfer and relocation source steps keep theirs held. */
      reservation?: 'keep' | 'settle' | 'release'
    }
  | { kind: 'not-delivered'; refusal: SessionHostRefusal }
  | { kind: 'unconfirmed'; detail: string }

function defaultReservationEnd(
  operation: SessionHostJournalOperation
): 'keep' | 'settle' | 'release' {
  if (!sessionHostActionConsumesTurn(operation.action)) {
    return 'release'
  }
  const spec = SESSION_HOST_ACTION_SPECS[operation.action]
  const ends =
    operation.action === 'transfer.settle-source' || operation.action === 'relocate.relinquish'
  const source =
    (spec.feature === 'transfer' || spec.feature === 'relocation') && spec.fence === 'turn'
  return source && !ends ? 'keep' : 'settle'
}

export function settleSessionHostOperation(
  journal: SessionHostJournal,
  operation: SessionHostJournalOperation,
  settlement: SessionHostSettlement,
  at: number
): void {
  const reservation = journal.reservations[operation.runsUnder ?? operation.operationId]
  operation.settledAt = at
  if (settlement.kind === 'completed') {
    operation.state = 'completed'
    operation.result = settlement.result
    if (settlement.verdict) {
      operation.verdict = settlement.verdict
    }
  } else if (settlement.kind === 'not-delivered') {
    operation.state = 'refused'
    operation.refusal = settlement.refusal
  } else {
    operation.state = 'unconfirmed'
    operation.audit = { ...operation.audit, detail: settlement.detail }
  }
  if (!reservation) {
    return
  }
  reservation.running = undefined
  if (settlement.kind === 'unconfirmed') {
    // Why it blocks on: bytes may have moved, so nothing else may take the conversation until a
    // reconciliation proves what happened.
    reservation.state = 'unconfirmed'
    return
  }
  const ownsReservation = !operation.runsUnder
  const end =
    settlement.kind === 'not-delivered'
      ? ownsReservation
        ? 'release'
        : 'keep'
      : (settlement.reservation ?? defaultReservationEnd(operation))
  reservation.state = end === 'keep' ? 'held' : end === 'settle' ? 'settled' : 'released'
  const reserveOperation = journal.operations[reservation.operationId]
  if (
    end !== 'keep' &&
    reserveOperation?.kind === 'reserve' &&
    reserveOperation.state === 'admitted'
  ) {
    reserveOperation.state = 'completed'
    reserveOperation.result = { reservation: reservation.state }
    reserveOperation.settledAt = at
  }
}
