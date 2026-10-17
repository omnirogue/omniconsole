/**
 * Durable admission at the final write boundary: one admitted action per turn, no blind redelivery.
 *
 * Every operation moves admitted → dispatched → settled, each step durable before the next begins:
 * - admitted: intent and reservation are on disk, nothing has been sent. A process that dies here
 *   provably sent nothing, so reconciliation refuses it and frees the turn.
 * - dispatched: written BEFORE the executor is called; bytes may have moved from here on. A process
 *   that dies here leaves it `unconfirmed`, never resent, still blocking the conversation.
 * - settled: completed, refused (provably nothing delivered) or unconfirmed.
 * A duplicate operation id returns its record and never dispatches again.
 */

import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import { decideSessionHostAdmission } from '../../shared/session-host-admission'
import type { SessionHostIdentity } from '../../shared/session-host-identity'
import {
  SESSION_HOST_ACTION_SPECS,
  type SessionHostRequest
} from '../../shared/session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import {
  sessionHostAdmissionFacts,
  sessionHostControllerRefusal,
  sessionHostReservationRefusal,
  type SessionHostTurnReading
} from './session-host-admission-facts'
import type {
  SessionHostJournal,
  SessionHostJournalOperation,
  SessionHostJournalReservation,
  SessionHostOperationAudit,
  SessionHostRegistration
} from './session-host-journal'
import { SessionHostStorageError, type SessionHostJournalFile } from './session-host-journal-file'
import { evictSettledSessionHostOperations } from './session-host-reconcile'
import { settleSessionHostOperation, type SessionHostSettlement } from './session-host-settlement'

export type { SessionHostSettlement } from './session-host-settlement'

export type SessionHostAdmitInput = {
  /** The request as the reference decision reads it (in-process callers get a synthetic origin). */
  request: SessionHostRequest
  fingerprint: string
  kind: 'execute' | 'reserve' | 'local-write'
  holder: string
  audit: SessionHostOperationAudit
  admissionOpen: boolean
  readTurn: (registration: SessionHostRegistration) => Promise<SessionHostTurnReading>
  /** Local writers act on the current turn: their send door checked readiness just before. */
  expectCurrentTurn?: boolean
}

export type SessionHostAdmission =
  | { kind: 'replay'; operation: SessionHostJournalOperation }
  | { kind: 'refused'; operation: SessionHostJournalOperation }
  | {
      kind: 'admitted'
      operation: SessionHostJournalOperation
      registration: SessionHostRegistration | null
    }
  /** Nothing was recorded: storage failed, the id conflicts, or it is older than the journal. */
  | { kind: 'unrecorded'; refusal: SessionHostRefusal }

const UNREADABLE_TURN = sessionHostRefusal(
  'storage-unavailable',
  'That computer could not read the conversation’s current state, so nothing was reserved against it. Nothing was changed.'
)

export class SessionHostAdmissionStore {
  constructor(
    readonly file: SessionHostJournalFile,
    readonly host: SessionHostIdentity,
    readonly now: () => number = Date.now
  ) {}

  /** A locked read-modify-write; `apply` returns whether it changed the journal. */
  async mutate<T>(
    apply: (journal: SessionHostJournal) => Promise<{ value: T; changed: boolean }>
  ): Promise<T> {
    return await this.file.transact(async () => {
      const read = this.file.read(this.host.hostId)
      if (!read.ok) {
        throw new SessionHostStorageError(
          `This computer's session records are unreadable: ${read.detail}.`
        )
      }
      if (!read.writable) {
        throw new SessionHostStorageError(
          'A newer OmniConsole on this computer wrote its session records, so this one does not change them.'
        )
      }
      const { value, changed } = await apply(read.journal)
      if (changed) {
        this.file.write(read.journal)
      }
      return value
    })
  }

  /** Unlocked: the journal is only ever replaced by an atomic rename. */
  snapshot(): SessionHostJournal | null {
    const read = this.file.read(this.host.hostId)
    return read.ok ? read.journal : null
  }

  async admit(input: SessionHostAdmitInput): Promise<SessionHostAdmission> {
    try {
      return await this.mutate(async (journal) => await this.decide(journal, input))
    } catch (error) {
      if (error instanceof SessionHostStorageError) {
        return {
          kind: 'unrecorded',
          refusal: sessionHostRefusal(
            'storage-unavailable',
            `${error.message} Nothing was changed.`
          )
        }
      }
      throw error
    }
  }

  private async decide(
    journal: SessionHostJournal,
    input: SessionHostAdmitInput
  ): Promise<{ value: SessionHostAdmission; changed: boolean }> {
    const unchanged = (value: SessionHostAdmission) => ({ value, changed: false })
    const existing = journal.operations[input.request.operationId]
    const stamp = parseAgentSessionOperationTimestamp(input.request.operationId) ?? 0
    if (!existing && stamp <= journal.horizon) {
      return unchanged({
        kind: 'unrecorded',
        refusal: sessionHostRefusal(
          'invalid-request',
          'That operation id is older than this computer’s record of operations, so it cannot be checked for a repeat. Send a new one. Nothing was changed.'
        )
      })
    }
    const spec = SESSION_HOST_ACTION_SPECS[input.request.action]
    const found = journal.conversations[input.request.conversationId] ?? null
    const registration = spec.fence === 'destination' ? null : found
    const controllerRefusal = existing
      ? null
      : sessionHostControllerRefusal({ journal, registration, controller: this.host.incarnation })
    if (controllerRefusal) {
      return this.record(journal, input, found, null, controllerRefusal)
    }
    let reading: SessionHostTurnReading = { turnRevision: null, organizationRevision: null }
    if (!existing && registration?.owned && registration.adopted && spec.fence !== 'owner') {
      reading = await input.readTurn(registration).catch((): SessionHostTurnReading => 'unreadable')
      if (reading === 'unreadable') {
        return this.record(journal, input, found, null, UNREADABLE_TURN)
      }
    }
    const request =
      input.expectCurrentTurn && registration
        ? {
            ...input.request,
            expectedOwnerEpoch: registration.ownerEpoch,
            expectedTurnRevision: reading.turnRevision
          }
        : input.request
    const facts = sessionHostAdmissionFacts({
      journal,
      request,
      fingerprint: input.fingerprint,
      registration: found,
      reading,
      admissionOpen: input.admissionOpen
    })
    const decision = decideSessionHostAdmission(request, input.fingerprint, facts)
    if (decision.kind === 'replay') {
      return unchanged({ kind: 'replay', operation: existing! })
    }
    if (decision.kind === 'refuse') {
      // Why unrecorded: the id already belongs to a different request, whose record must stand.
      return decision.refusal.code === 'operation-conflict'
        ? unchanged({ kind: 'unrecorded', refusal: decision.refusal })
        : this.record(journal, input, found, reading.turnRevision, decision.refusal)
    }
    const refusal = sessionHostReservationRefusal({
      journal,
      request,
      fence: spec.fence,
      holder: input.holder
    })
    if (refusal) {
      return this.record(journal, input, found, reading.turnRevision, refusal)
    }
    const at = this.now()
    const operation = this.operationRecord(
      input,
      found,
      spec.fence === 'turn' ? reading.turnRevision : null,
      'admitted'
    )
    operation.admittedAt = at
    if (request.reservation !== undefined) {
      operation.runsUnder = request.reservation
      journal.reservations[request.reservation]!.running = operation.operationId
    } else if (decision.reservationKey !== null) {
      journal.reservations[operation.operationId] = {
        operationId: operation.operationId,
        conversationId: operation.conversationId,
        hostId: this.host.hostId,
        holder: input.holder,
        ownerEpoch: operation.ownerEpoch,
        turnRevision: operation.turnRevision,
        state: 'held',
        heldAt: at,
        action: operation.action,
        key: decision.reservationKey
      }
    }
    journal.operations[operation.operationId] = operation
    return { value: { kind: 'admitted', operation, registration }, changed: true }
  }

  private operationRecord(
    input: SessionHostAdmitInput,
    registration: SessionHostRegistration | null,
    turnRevision: string | null,
    state: 'admitted' | 'refused'
  ): SessionHostJournalOperation {
    const { request } = input
    return {
      operationId: request.operationId,
      conversationId: request.conversationId,
      action: request.action,
      state,
      fingerprint: input.fingerprint,
      host: this.host,
      ownerEpoch: registration?.ownerEpoch ?? request.expectedOwnerEpoch,
      turnRevision,
      kind: input.kind,
      holder: input.holder,
      controller: this.host.incarnation,
      audit: input.audit
    }
  }

  private record(
    journal: SessionHostJournal,
    input: SessionHostAdmitInput,
    registration: SessionHostRegistration | null,
    turnRevision: string | null,
    refusal: SessionHostRefusal
  ): { value: SessionHostAdmission; changed: boolean } {
    const operation = {
      ...this.operationRecord(input, registration, turnRevision, 'refused'),
      refusal,
      settledAt: this.now()
    }
    journal.operations[operation.operationId] = operation
    return { value: { kind: 'refused', operation }, changed: true }
  }

  /** Durable before the executor is called; false means this process must not dispatch it. */
  async markDispatched(operationId: string): Promise<boolean> {
    return await this.mutate(async (journal) => {
      const operation = journal.operations[operationId]
      if (operation?.state !== 'admitted' || operation.controller !== this.host.incarnation) {
        return { value: false, changed: false }
      }
      operation.state = 'dispatched'
      const reservation = this.reservationOf(journal, operation)
      if (reservation) {
        reservation.state = 'dispatched'
      }
      return { value: true, changed: true }
    })
  }

  async settle(
    operationId: string,
    settlement: SessionHostSettlement
  ): Promise<SessionHostJournalOperation> {
    return await this.mutate(async (journal) => {
      const operation = journal.operations[operationId]
      if (!operation) {
        throw new SessionHostStorageError(
          `Operation ${operationId} vanished from this computer's session records.`
        )
      }
      if (operation.state !== 'admitted' && operation.state !== 'dispatched') {
        return { value: operation, changed: false }
      }
      settleSessionHostOperation(journal, operation, settlement, this.now())
      evictSettledSessionHostOperations(journal, this.now())
      return { value: operation, changed: true }
    })
  }

  private reservationOf(
    journal: SessionHostJournal,
    operation: SessionHostJournalOperation
  ): SessionHostJournalReservation | null {
    return journal.reservations[operation.runsUnder ?? operation.operationId] ?? null
  }
}
