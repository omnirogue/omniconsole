/**
 * The host's owner entry point for admission. A remote computer reaches it through the gated
 * `sessionHost.*` methods; this host's own UI, CLI and steward call it in process. Either way one
 * sequence runs: admit durably, let the executor check and prepare, record dispatch durably, send,
 * then record what the send proved. Only the call that admitted an operation ever dispatches it.
 */

import { sessionHostPromptMarker } from '../../shared/session-host-authority'
import type { SessionHostCapability } from '../../shared/session-host-capabilities'
import type { SessionHostIdentity } from '../../shared/session-host-identity'
import type {
  SessionHostExecuteResult,
  SessionHostObserveParams,
  SessionHostObserveResult,
  SessionHostOperationParams,
  SessionHostOperationResult,
  SessionHostReleaseParams
} from '../../shared/session-host-protocol'
import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session-host-authority'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostAdmission,
  SessionHostAdmissionStore
} from './session-host-admission-store'
import {
  sessionHostAudit,
  sessionHostDecisionRequest,
  sessionHostFingerprint,
  sessionHostHolder,
  sessionHostReleaseFingerprint,
  type SessionHostInProcessAuthority,
  type SessionHostRemoteAuthority
} from './session-host-caller'
import {
  advertisableSessionHostCapabilities,
  readSessionHostTurn,
  type SessionHostExecutionRequest,
  type SessionHostExecutor,
  type SessionHostPrepared
} from './session-host-executor'
import { sessionHostWireOperation } from './session-host-journal'
import { observeSessionHost } from './session-host-observe'
import { releaseSessionHostReservation } from './session-host-reservation-release'
import type { SessionHostSettlement } from './session-host-settlement'

const STORAGE_BEFORE_DISPATCH = sessionHostRefusal(
  'storage-unavailable',
  'That computer could not record the action before sending it, so it did not send it. Nothing was delivered.'
)

type Authority = SessionHostInProcessAuthority | SessionHostRemoteAuthority

function reply(admission: SessionHostAdmission): SessionHostExecuteResult {
  return admission.kind === 'unrecorded'
    ? { status: 'refused', refusal: admission.refusal }
    : { status: 'ok', operation: sessionHostWireOperation(admission.operation) }
}

export class SessionHostService {
  private admissionHolds = 0

  constructor(
    readonly store: SessionHostAdmissionStore,
    private readonly executorOf: () => SessionHostExecutor
  ) {}

  get identity(): SessionHostIdentity {
    return this.store.host
  }

  capabilities(): SessionHostCapability[] {
    return advertisableSessionHostCapabilities(this.executorOf())
  }

  /** Closed while this process (or its executor) is still reconciling after a restart. */
  admissionOpen(): boolean {
    return this.admissionHolds === 0 && this.executorOf().reconciled()
  }

  /** Package B holds admission closed across its own reconciliation; the release reopens it. */
  holdAdmission(): () => void {
    this.admissionHolds += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        this.admissionHolds -= 1
      }
    }
  }

  async execute(
    request: SessionHostExecutionRequest,
    authority: Authority
  ): Promise<SessionHostExecuteResult> {
    return await this.run(request, authority, 'execute')
  }

  /** An `admitted` operation that holds the conversation and sends nothing. */
  async reserve(
    request: SessionHostExecutionRequest,
    authority: Authority
  ): Promise<SessionHostExecuteResult> {
    return await this.run(request, authority, 'reserve')
  }

  private async run(
    request: SessionHostExecutionRequest,
    authority: Authority,
    kind: 'execute' | 'reserve'
  ): Promise<SessionHostExecuteResult> {
    const executor = this.executorOf()
    const admission = await this.store.admit({
      request: sessionHostDecisionRequest(request, authority),
      fingerprint: sessionHostFingerprint(request, authority),
      kind,
      holder: sessionHostHolder(authority),
      audit: sessionHostAudit(authority),
      admissionOpen: this.admissionOpen(),
      readTurn: (registration) => readSessionHostTurn(executor, registration)
    })
    if (admission.kind !== 'admitted' || kind === 'reserve') {
      return reply(admission)
    }
    const { operation, registration } = admission
    const prepared: SessionHostPrepared = await executor
      .prepare({
        request,
        authority,
        operation,
        registration,
        marker: sessionHostPromptMarker(authority)
      })
      .catch((error: unknown) => ({
        kind: 'refuse',
        refusal: sessionHostRefusal(
          'not-eligible',
          `That computer could not prepare ${request.action} (${error instanceof Error ? error.message : String(error)}). Nothing was delivered.`
        )
      }))
    if (prepared.kind === 'refuse') {
      return await this.settleUnsent(operation.operationId, prepared.refusal)
    }
    // Why durable first: from here bytes may move, and a crash must leave this unconfirmed, not free.
    const dispatchable = await this.store.markDispatched(operation.operationId).catch(() => null)
    if (dispatchable === null) {
      return await this.settleUnsent(operation.operationId, STORAGE_BEFORE_DISPATCH)
    }
    if (!dispatchable) {
      const current = this.store.snapshot()?.operations[operation.operationId] ?? operation
      return { status: 'ok', operation: sessionHostWireOperation(current) }
    }
    let settlement: SessionHostSettlement
    try {
      settlement = await prepared.dispatch()
    } catch (error) {
      settlement = {
        kind: 'unconfirmed',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    try {
      return reply({
        kind: 'admitted',
        operation: await this.store.settle(operation.operationId, settlement),
        registration
      })
    } catch {
      // The dispatch is on disk; a restart turns it unconfirmed. Never reported as not sent.
      return {
        status: 'ok',
        operation: sessionHostWireOperation({ ...operation, state: 'dispatched' })
      }
    }
  }

  /** Nothing moved: record the refusal; if even that fails, a restart reconciles it as unsent. */
  private async settleUnsent(
    operationId: string,
    refusal: SessionHostRefusal
  ): Promise<SessionHostExecuteResult> {
    try {
      const operation = await this.store.settle(operationId, { kind: 'not-delivered', refusal })
      return reply({ kind: 'refused', operation })
    } catch {
      return { status: 'refused', refusal }
    }
  }

  async release(
    params: Omit<SessionHostReleaseParams, 'origin'>,
    authority: Authority
  ): Promise<SessionHostExecuteResult> {
    return reply(
      await releaseSessionHostReservation(this.store, {
        operationId: params.operationId,
        conversationId: params.conversationId,
        reservation: params.reservation,
        holder: sessionHostHolder(authority),
        fingerprint: sessionHostReleaseFingerprint(params, authority),
        audit: sessionHostAudit(authority)
      })
    )
  }

  /** `found: false` only when the journal provably never recorded that id. */
  operation(params: SessionHostOperationParams): SessionHostOperationResult {
    const journal = this.store.snapshot()
    if (!journal) {
      return {
        status: 'refused',
        refusal: sessionHostRefusal(
          'storage-unavailable',
          "That computer's session records are unreadable."
        )
      }
    }
    const operation = journal.operations[params.operationId]
    if (operation) {
      return operation.conversationId === params.conversationId
        ? { status: 'ok', found: true, operation: sessionHostWireOperation(operation) }
        : {
            status: 'refused',
            refusal: sessionHostRefusal(
              'invalid-request',
              'That operation belongs to a different conversation.'
            )
          }
    }
    if ((parseAgentSessionOperationTimestamp(params.operationId) ?? 0) <= journal.horizon) {
      return {
        status: 'refused',
        refusal: sessionHostRefusal(
          'invalid-request',
          'That operation id is older than this computer’s record of operations, so it cannot say.'
        )
      }
    }
    return { status: 'ok', found: false, host: this.store.host }
  }

  async observe(params: SessionHostObserveParams): Promise<SessionHostObserveResult> {
    return await observeSessionHost({
      store: this.store,
      executor: this.executorOf(),
      admissionOpen: this.admissionOpen(),
      params
    })
  }

  executor(): SessionHostExecutor {
    return this.executorOf()
  }
}
