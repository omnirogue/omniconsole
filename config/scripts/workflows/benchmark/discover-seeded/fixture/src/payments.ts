import { newId, type Currency, type Db, type OrderRow, type PaymentRow } from './db'

export type CaptureResult = { id: string; declined: boolean; reason?: string }

/** The card processor. Both calls are idempotent per key; both can throw on network errors. */
export type Gateway = {
  capture(
    orderId: string,
    cents: number,
    currency: Currency,
    idempotencyKey: string
  ): Promise<CaptureResult>
  refund(paymentId: string, cents: number, idempotencyKey: string): Promise<void>
}

export class PaymentDeclinedError extends Error {
  constructor(
    readonly orderId: string,
    readonly reason: string
  ) {
    super(`Payment for ${orderId} declined: ${reason}`)
  }
}

const MAX_ATTEMPTS = 3
const BACKOFF_MS = 250

/**
 * Captures payment for orders and refunds it. Transient gateway errors are retried with
 * exponential backoff under one idempotency key, so a retry never charges twice.
 */
export class Payments {
  constructor(
    private readonly db: Db,
    private readonly gateway: Gateway,
    private readonly log: (message: string, detail?: Record<string, unknown>) => void,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async capture(order: OrderRow): Promise<PaymentRow> {
    const key = `capture:${order.id}`
    let result: CaptureResult | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        result = await this.gateway.capture(order.id, order.totalCents, order.currency, key)
        break
      } catch (error) {
        this.log('capture attempt failed', { orderId: order.id, attempt, error: String(error) })
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS * 2 ** (attempt - 1))
        }
      }
    }
    if (result?.declined) {
      await this.db.payments.put(`declined:${order.id}`, {
        id: `declined:${order.id}`,
        orderId: order.id,
        currency: order.currency,
        capturedCents: 0,
        refundedCents: 0,
        status: 'failed'
      })
      throw new PaymentDeclinedError(order.id, result.reason ?? 'declined')
    }
    const payment: PaymentRow = {
      id: result?.id ?? newId('pay'),
      orderId: order.id,
      currency: order.currency,
      capturedCents: order.totalCents,
      refundedCents: 0,
      status: 'captured'
    }
    await this.db.payments.put(payment.id, payment)
    return payment
  }

  /** Refunds part or all of a captured payment; several partial refunds may follow each other. */
  async refund(paymentId: string, cents: number): Promise<PaymentRow> {
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new RangeError('A refund is a positive number of cents')
    }
    const payment = await this.db.payments.get(paymentId)
    if (!payment || payment.status === 'failed') {
      throw new Error(`No captured payment ${paymentId}`)
    }
    if (cents > payment.capturedCents) {
      throw new RangeError('The refund is larger than what is left to refund')
    }
    await this.gateway.refund(payment.id, cents, `refund:${payment.id}:${payment.refundedCents}`)
    const refundedCents = payment.refundedCents + cents
    const updated: PaymentRow = {
      ...payment,
      refundedCents,
      status: refundedCents >= payment.capturedCents ? 'refunded' : 'captured'
    }
    await this.db.payments.put(payment.id, updated)
    return updated
  }

  async get(paymentId: string): Promise<PaymentRow | undefined> {
    return this.db.payments.get(paymentId)
  }

  async forOrder(orderId: string): Promise<PaymentRow | undefined> {
    return (await this.db.payments.list()).find(
      (payment) => payment.orderId === orderId && payment.status !== 'failed'
    )
  }
}
