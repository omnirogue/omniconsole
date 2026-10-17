/**
 * The conversation send door's half of admission (`conversation-delivery.ts`). Every automatic
 * writer on this host (prompt queue, chain turns, Up next, prompt-now) goes through that door, so
 * for a conversation the session host registry has ADOPTED each delivery is admitted here first:
 * one turn, one writer, whether the other writer is on this computer or another. A conversation
 * the registry has not adopted is delivered exactly as before.
 *
 * A delivery the host service already admitted and dispatched (package B executing a remote
 * `continue`) names that operation instead, and is checked rather than admitted twice.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import { isSessionHostOperationId, sessionHostDigest } from '../../shared/session-host-identity'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import { ConversationNotSentError } from '../runtime/conversation-delivery-not-sent'
import { readSessionHostTurn, type SessionHostExecutor } from './session-host-executor'
import type { SessionHostRegistration } from './session-host-journal'
import { reconcileSessionHostOperation } from './session-host-reservation-release'
import { findSessionHostRegistration } from './session-host-ownership-registry'
import type { SessionHostProcess } from './session-host-process'
import type { SessionHostService } from './session-host-service'

export type SessionHostDeliveryAdmission = {
  /** Set by the host service's own dispatch: the admitted operation this delivery carries out. */
  hostOperation?: { operationId: string; conversationId: string }
  /** Who is writing (`prompt-queue`, `same-session`, …): the reservation holder and the audit. */
  writer?: string
}

/** Refused by admission before any byte moved; like every `ConversationNotSentError`, retryable. */
export class SessionHostDeliveryRefusedError extends ConversationNotSentError {
  constructor(readonly refusal: SessionHostRefusal) {
    super(refusal.message)
    this.name = 'SessionHostDeliveryRefusedError'
  }
}

type Delivered = { door: 'pty' | 'structured'; deliveredAt: number }

async function openedService(host: SessionHostProcess): Promise<SessionHostService | null> {
  try {
    return await host.serviceIfPresent()
  } catch (error) {
    // Why closed: with the registry present but unreadable, adoption cannot be ruled out.
    throw new SessionHostDeliveryRefusedError(
      sessionHostRefusal(
        'storage-unavailable',
        `This computer's session host records could not be opened (${error instanceof Error ? error.message : String(error)}), so no automatic delivery goes out. Nothing was sent.`
      )
    )
  }
}

function replayed(
  state: string,
  result: unknown,
  refusal: SessionHostRefusal | undefined
): Delivered {
  if (state === 'completed' && result && typeof result === 'object') {
    return result as Delivered
  }
  if (state === 'refused' && refusal) {
    throw new SessionHostDeliveryRefusedError(refusal)
  }
  // Why not "not sent": an earlier attempt under this id may have delivered it.
  throw new Error(
    'An earlier attempt to deliver this is still unaccounted for, so it is not sent again.'
  )
}

/**
 * An earlier local write left unconfirmed blocks every later one for this conversation. Once the
 * conversation has taken a new turn since it, it is settled the way the restart reconciler settles
 * one (`session-host-owner-reconcile.ts`): the turn it fenced can no longer be sent to.
 */
async function reconcileMovedLocalWrites(
  service: SessionHostService,
  executor: SessionHostExecutor,
  registration: SessionHostRegistration
): Promise<void> {
  const operations = Object.values(service.store.snapshot()?.operations ?? {}).filter(
    (operation) =>
      operation.state === 'unconfirmed' &&
      operation.kind === 'local-write' &&
      operation.conversationId === registration.conversationId
  )
  if (operations.length === 0) {
    return
  }
  const reading = await readSessionHostTurn(executor, registration).catch(
    () => 'unreadable' as const
  )
  if (reading === 'unreadable' || reading.turnRevision === null) {
    return
  }
  for (const operation of operations) {
    if (operation.turnRevision !== reading.turnRevision) {
      await reconcileSessionHostOperation(service.store, operation.operationId, {
        delivered: true,
        note: 'the conversation took a new turn after it'
      }).catch(() => null)
    }
  }
}

export async function deliverUnderSessionHostAdmission(input: {
  host: SessionHostProcess | null
  source: ConversationSource
  text: string
  operationId: string
  admission?: SessionHostDeliveryAdmission
  deliver: () => Promise<Delivered>
}): Promise<Delivered> {
  const service = input.host ? await openedService(input.host) : null
  const journal = service?.store.snapshot()
  const registration = journal ? findSessionHostRegistration(journal, input.source) : null
  if (!service || !registration?.adopted) {
    return await input.deliver()
  }
  const named = input.admission?.hostOperation
  if (named) {
    const operation = journal?.operations[named.operationId]
    if (
      operation?.state !== 'dispatched' ||
      operation.conversationId !== registration.conversationId ||
      operation.controller !== service.identity.incarnation
    ) {
      throw new SessionHostDeliveryRefusedError(
        sessionHostRefusal(
          'reservation-invalid',
          'This delivery names a host operation that is not the one being dispatched. Nothing was sent.'
        )
      )
    }
    return await input.deliver()
  }
  if (!isSessionHostOperationId(input.operationId)) {
    throw new SessionHostDeliveryRefusedError(
      sessionHostRefusal(
        'invalid-request',
        'This delivery has no durable operation id, so this session’s host cannot admit it. Nothing was sent.'
      )
    )
  }
  const writer = input.admission?.writer ?? 'conversation-delivery'
  const request = {
    operationId: input.operationId,
    conversationId: registration.conversationId,
    expectedOwnerEpoch: registration.ownerEpoch,
    expectedTurnRevision: null,
    origin: { computer: 'this computer', requester: { kind: 'person', via: 'this-computer' } },
    action: 'continue',
    payload: { answer: { kind: 'prompt', text: input.text } }
  } satisfies SessionHostRequest
  const executor = service.executor()
  await reconcileMovedLocalWrites(service, executor, registration)
  const admission = await service.store.admit({
    request,
    fingerprint: sessionHostDigest(
      JSON.stringify([
        'session-host-local-write/v1',
        registration.conversationId,
        writer,
        sessionHostDigest(input.text)
      ])
    ),
    kind: 'local-write',
    holder: `local-writer:${writer}`,
    audit: { authority: 'local-writer', requester: writer },
    admissionOpen: service.admissionOpen(),
    readTurn: (target) => readSessionHostTurn(executor, target),
    expectCurrentTurn: true
  })
  if (admission.kind === 'unrecorded') {
    throw new SessionHostDeliveryRefusedError(admission.refusal)
  }
  if (admission.kind !== 'admitted') {
    const { state, result, refusal } = admission.operation
    return replayed(state, result, refusal)
  }
  const { operationId } = admission.operation
  const dispatchable = await service.store.markDispatched(operationId).catch(() => null)
  if (!dispatchable) {
    const refusal =
      dispatchable === null
        ? sessionHostRefusal(
            'storage-unavailable',
            'This delivery could not be recorded before it went out, so it did not go out. Nothing was sent.'
          )
        : sessionHostRefusal(
            'reconciling',
            'This delivery was reconciled before it went out. Nothing was sent.'
          )
    await service.store.settle(operationId, { kind: 'not-delivered', refusal }).catch(() => {})
    throw new SessionHostDeliveryRefusedError(refusal)
  }
  let delivered: Delivered
  try {
    delivered = await input.deliver()
  } catch (error) {
    const settlement =
      error instanceof ConversationNotSentError
        ? {
            kind: 'not-delivered' as const,
            refusal: sessionHostRefusal('not-eligible', error.message)
          }
        : {
            kind: 'unconfirmed' as const,
            detail: error instanceof Error ? error.message : String(error)
          }
    await service.store.settle(operationId, settlement).catch(() => {})
    throw error
  }
  // A lost record leaves it dispatched, which a restart turns unconfirmed: never sent twice.
  await service.store.settle(operationId, { kind: 'completed', result: delivered }).catch(() => {})
  return delivered
}
