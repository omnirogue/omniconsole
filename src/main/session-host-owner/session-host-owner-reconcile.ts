/**
 * After a restart, before admission reopens: a `continue` or `ask` a dead process left
 * `unconfirmed` is settled from its own queue entry, which carries the host operation. Delivered
 * is delivered; an entry that provably sent nothing (or never got queued, or was still queued and
 * is withdrawn now) was not delivered. A send that started and never reported stays unconfirmed,
 * fencing the conversation, until the conversation takes a new turn after it.
 */

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { SessionHostTurnReading } from '../session-host/session-host-admission-facts'
import type { SessionHostRegistration } from '../session-host/session-host-journal'
import { reconcileSessionHostOperation } from '../session-host/session-host-reservation-release'
import type { SessionHostService } from '../session-host/session-host-service'

export type HostReconcileDeps = {
  readQueue(rowKey: string): PromptQueue | null
  /** Settles a still-queued entry failed in the same tick; false once it started sending. */
  withdraw(rowKey: string, entryId: string, reason: string): boolean
  readTurn(registration: SessionHostRegistration): Promise<SessionHostTurnReading>
}

const RESTARTED = 'This computer restarted before it was sent, so it was withdrawn unsent.'

export async function reconcileHostDeliveries(
  service: SessionHostService,
  deps: HostReconcileDeps
): Promise<number> {
  const journal = service.store.snapshot()
  if (!journal) {
    return 0
  }
  let settled = 0
  for (const operation of Object.values(journal.operations)) {
    if (
      operation.state !== 'unconfirmed' ||
      (operation.action !== 'continue' && operation.action !== 'ask')
    ) {
      continue
    }
    const registration = journal.conversations[operation.conversationId]
    const binding = registration?.binding
    if (!registration || !binding) {
      continue
    }
    const rowKey = conversationSourceRowKey(binding)
    const entry = deps
      .readQueue(rowKey)
      ?.entries.find(
        (candidate) => candidate.requestedBy?.hostOperation?.operationId === operation.operationId
      )
    let evidence: { delivered: boolean; note: string } | null = null
    if (!entry) {
      // Why: a send flushes its entry to disk before a byte moves, so no entry means none started.
      evidence = { delivered: false, note: 'no queued prompt was recorded for it' }
    } else if (entry.state === 'delivered') {
      evidence = { delivered: true, note: 'its queued prompt was delivered' }
    } else if (entry.state === 'failed' && (entry.unsent || !entry.operationId)) {
      evidence = { delivered: false, note: entry.reason ?? 'its queued prompt was not sent' }
    } else if (entry.state === 'queued' && deps.withdraw(rowKey, entry.id, RESTARTED)) {
      evidence = { delivered: false, note: 'it was still queued and was withdrawn' }
    } else {
      const reading = await deps.readTurn(registration)
      if (
        reading !== 'unreadable' &&
        reading.turnRevision !== null &&
        reading.turnRevision !== operation.turnRevision
      ) {
        // Why delivered: the conversation moved on, so the turn it fenced can no longer be sent to.
        evidence = { delivered: true, note: 'the conversation took a new turn after it' }
      }
    }
    if (
      evidence &&
      (await reconcileSessionHostOperation(service.store, operation.operationId, evidence))
    ) {
      settled += 1
    }
  }
  return settled
}
