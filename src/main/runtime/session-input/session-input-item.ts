/**
 * One queued item's lifetime: its cancel-gated delivery context and the single
 * place an item turns into a receipt.
 *
 * Cancelling an item kills its writer first, so a delivery that is still
 * unwinding — a worker awaiting a render gate, a paced key sequence — cannot put
 * another byte into a session it no longer owns.
 */

import type {
  SessionInputCancelReason,
  SessionInputOrigin,
  SessionInputReceipt
} from '../../../shared/session-input-program'
import {
  SessionInputCancelledError,
  isSessionInputCancelledError,
  type SessionInputDeliveryContext
} from './session-input-delivery-context'

export type SessionInputItem = {
  clientMessageId: string
  origin: SessionInputOrigin
  ptyId: string
  /** The dedupe subject this item claimed, so a cancel can release it. */
  body?: string
  cancelReason: SessionInputCancelReason | null
  controller: AbortController
  /** Resolves on cancellation so the session's turn advances immediately. */
  cancelled: Promise<void>
  markCancelled: () => void
}

/** Host byte writer for one queued write step. False means the PTY refused it. */
export type SessionInputByteWriter = (
  ptyId: string,
  data: string,
  options: { signal: AbortSignal }
) => boolean | Promise<boolean>

export type SessionInputItemOutcome<T> = {
  receipt: SessionInputReceipt
  value?: T
  error?: unknown
}

export function createSessionInputItem(args: {
  clientMessageId: string
  origin: SessionInputOrigin
  ptyId: string
  body?: string
}): SessionInputItem {
  let markCancelled = (): void => {}
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve
  })
  return {
    clientMessageId: args.clientMessageId,
    origin: args.origin,
    ptyId: args.ptyId,
    ...(args.body !== undefined ? { body: args.body } : {}),
    cancelReason: null,
    controller: new AbortController(),
    cancelled,
    markCancelled
  }
}

export function cancelSessionInputItem(
  item: SessionInputItem,
  reason: SessionInputCancelReason
): boolean {
  if (item.cancelReason) {
    return false
  }
  item.cancelReason = reason
  item.controller.abort()
  item.markCancelled()
  return true
}

export function cancelledSessionInputReceipt(item: SessionInputItem): SessionInputReceipt {
  return {
    clientMessageId: item.clientMessageId,
    status: 'cancelled',
    reason: item.cancelReason ?? 'caller-cancelled'
  }
}

export function pauseSessionInputItem(item: SessionInputItem, ms: number): Promise<void> {
  if (item.cancelReason) {
    return Promise.reject(new SessionInputCancelledError(item.cancelReason))
  }
  if (!(ms > 0)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const signal = item.controller.signal
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new SessionInputCancelledError(item.cancelReason ?? 'caller-cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createSessionInputDeliveryContext(
  item: SessionInputItem,
  write: SessionInputByteWriter
): SessionInputDeliveryContext {
  const assertActive = (): void => {
    if (item.cancelReason) {
      throw new SessionInputCancelledError(item.cancelReason)
    }
  }
  return {
    ptyId: item.ptyId,
    origin: item.origin,
    clientMessageId: item.clientMessageId,
    signal: item.controller.signal,
    assertActive,
    write: async (data: string) => {
      assertActive()
      // Why the signal: a chunked write must stop mid-payload on cancellation
      // rather than feed the rest of a paste to a session it no longer owns.
      return await write(item.ptyId, data, { signal: item.controller.signal })
    },
    pause: (ms: number) => pauseSessionInputItem(item, ms)
  }
}

/** Run the delivery and resolve the item's receipt. Never rejects. */
export function executeSessionInputItem<T>(
  item: SessionInputItem,
  deliver: (ctx: SessionInputDeliveryContext) => Promise<T>,
  hooks: {
    write: SessionInputByteWriter
    onDelivered: (item: SessionInputItem, receipt: SessionInputReceipt) => void
  }
): Promise<SessionInputItemOutcome<T>> {
  if (item.cancelReason) {
    return Promise.resolve({ receipt: cancelledSessionInputReceipt(item) })
  }
  const delivery = deliver(createSessionInputDeliveryContext(item, hooks.write)).then(
    (value): SessionInputItemOutcome<T> => {
      if (item.cancelReason) {
        return { receipt: cancelledSessionInputReceipt(item) }
      }
      const receipt: SessionInputReceipt = {
        clientMessageId: item.clientMessageId,
        status: 'delivered'
      }
      hooks.onDelivered(item, receipt)
      return { receipt, value }
    },
    (error): SessionInputItemOutcome<T> => {
      if (isSessionInputCancelledError(error) || item.cancelReason) {
        return { receipt: cancelledSessionInputReceipt(item) }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        receipt: {
          clientMessageId: item.clientMessageId,
          status: 'failed',
          errorCode: message,
          errorMessage: message
        },
        error
      }
    }
  )
  // Why: a cancelled item gives up its turn at once. Waiting for a dead delivery
  // to unwind would hold the incoming owner out of a session it already owns.
  return Promise.race([
    delivery,
    item.cancelled.then((): SessionInputItemOutcome<T> => ({
      receipt: cancelledSessionInputReceipt(item)
    }))
  ])
}
