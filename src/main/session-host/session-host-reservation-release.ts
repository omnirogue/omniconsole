/**
 * Ending a reservation without running anything under it: its holder releases a `held` one, or the
 * host reconciles an `unconfirmed` delivery from evidence. Nothing here ever resends.
 */

import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostAdmission,
  SessionHostAdmissionStore
} from './session-host-admission-store'
import { SessionHostStorageError } from './session-host-journal-file'
import type { SessionHostJournalOperation, SessionHostOperationAudit } from './session-host-journal'
import { settleSessionHostOperation } from './session-host-settlement'

export type SessionHostReleaseInput = {
  operationId: string
  conversationId: string
  reservation: string
  holder: string
  fingerprint: string
  audit: SessionHostOperationAudit
}

const INVALID = sessionHostRefusal(
  'reservation-invalid',
  'That reservation is not held by this requester, or is busy or already ended. Nothing was changed.'
)

function unrecorded(refusal: SessionHostRefusal): { value: SessionHostAdmission; changed: false } {
  return { value: { kind: 'unrecorded', refusal }, changed: false }
}

/** `sessionHost.release`: its own operation id, recorded, replayed like any other. */
export async function releaseSessionHostReservation(
  store: SessionHostAdmissionStore,
  input: SessionHostReleaseInput
): Promise<SessionHostAdmission> {
  try {
    return await store.mutate(async (journal) => {
      const existing = journal.operations[input.operationId]
      if (existing) {
        return existing.fingerprint === input.fingerprint
          ? { value: { kind: 'replay', operation: existing }, changed: false }
          : unrecorded(
              sessionHostRefusal(
                'operation-conflict',
                'That operation id was already used for a different request. Nothing was changed.'
              )
            )
      }
      if ((parseAgentSessionOperationTimestamp(input.operationId) ?? 0) <= journal.horizon) {
        return unrecorded(
          sessionHostRefusal(
            'invalid-request',
            'That operation id is too old. Nothing was changed.'
          )
        )
      }
      const reservation = journal.reservations[input.reservation]
      if (!reservation || reservation.conversationId !== input.conversationId) {
        return unrecorded(INVALID)
      }
      const releasable =
        reservation.holder === input.holder && reservation.state === 'held' && !reservation.running
      const at = store.now()
      const operation: SessionHostJournalOperation = {
        operationId: input.operationId,
        conversationId: input.conversationId,
        action: reservation.action,
        state: releasable ? 'completed' : 'refused',
        fingerprint: input.fingerprint,
        host: store.host,
        ownerEpoch: reservation.ownerEpoch,
        turnRevision: reservation.turnRevision,
        admittedAt: at,
        settledAt: at,
        kind: 'release',
        holder: input.holder,
        controller: store.host.incarnation,
        audit: input.audit,
        ...(releasable ? { result: { released: reservation.operationId } } : { refusal: INVALID })
      }
      journal.operations[operation.operationId] = operation
      if (releasable) {
        reservation.state = 'released'
        const reserve = journal.operations[reservation.operationId]
        if (reserve?.kind === 'reserve' && reserve.state === 'admitted') {
          reserve.state = 'completed'
          reserve.result = { reservation: 'released' }
          reserve.settledAt = at
        }
      }
      return {
        value: releasable
          ? { kind: 'admitted', operation, registration: null }
          : { kind: 'refused', operation },
        changed: true
      }
    })
  } catch (error) {
    if (error instanceof SessionHostStorageError) {
      return {
        kind: 'unrecorded',
        refusal: sessionHostRefusal('storage-unavailable', `${error.message} Nothing was changed.`)
      }
    }
    throw error
  }
}

/**
 * For the host's own reconciler (or a person) once evidence exists: an `unconfirmed` operation is
 * settled as delivered or as never delivered, which is what finally stops its reservation blocking.
 */
export async function reconcileSessionHostOperation(
  store: SessionHostAdmissionStore,
  operationId: string,
  evidence: { delivered: boolean; note: string }
): Promise<SessionHostJournalOperation | null> {
  return await store.mutate(async (journal) => {
    const operation = journal.operations[operationId]
    if (operation?.state !== 'unconfirmed') {
      return { value: operation ?? null, changed: false }
    }
    settleSessionHostOperation(
      journal,
      operation,
      evidence.delivered
        ? { kind: 'completed', result: { reconciled: evidence.note } }
        : {
            kind: 'not-delivered',
            refusal: sessionHostRefusal(
              'reconciling',
              `Reconciled: it never reached the conversation (${evidence.note}). Nothing was delivered.`
            )
          },
      store.now()
    )
    return { value: operation, changed: true }
  })
}
