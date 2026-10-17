import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type MessageRow, type OrchestrationDb } from './db'

export type OrchestrationMessageWaiter = { typeFilter: string[] | undefined }

export function messageTypeHasOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  messageType: string
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter || waiter.typeFilter.includes(messageType)) {
      return true
    }
  }
  return false
}

export function hasUnfilteredOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter) {
      return true
    }
  }
  return false
}

export function shouldReleaseOrchestrationPointer(
  db: OrchestrationDb | null,
  mailboxHandle: string,
  messages: readonly { id: string; type: string }[],
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  if (
    mailboxHandle.startsWith('run:') &&
    db?.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length))
  ) {
    return true
  }
  if (messages.some((message) => messageTypeHasOrchestrationWaiter(waiters, message.type))) {
    return true
  }
  return !(
    db?.areUnreadMessages?.(
      mailboxHandle,
      messages.map((message) => message.id)
    ) ?? true
  )
}

const POINTER_SILENT_TYPES: readonly string[] = ['heartbeat']

/** The batch a pointer announces; empty while only heartbeats wait, since they just refresh
 *  liveness and should ride along with the next actionable message, not wake the coordinator. */
export function selectPointerMail(
  db: OrchestrationDb,
  mailboxHandle: string,
  excludedTypes: ReadonlySet<string>,
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  reservedTypes: ReadonlySet<string> | undefined
): MessageRow[] {
  const unread = db
    .getUndeliveredUnreadMessages(mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    .filter(
      (message) =>
        !reservedTypes?.has(message.type) &&
        !messageTypeHasOrchestrationWaiter(waiters, message.type)
    )
    .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
  const wakes =
    unread.some((message) => !POINTER_SILENT_TYPES.includes(message.type)) ||
    db.getUndeliveredUnreadMessages(mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes, ...POINTER_SILENT_TYPES],
      limit: 1
    }).length > 0
  return wakes ? unread : []
}
