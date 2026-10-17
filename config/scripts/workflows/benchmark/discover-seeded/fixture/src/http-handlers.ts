import { OutOfStockError } from './inventory'
import { isCurrency, parseCents } from './money'
import { OrderNotFoundError, type OrderItem, type Orders } from './orders'
import { PaymentDeclinedError, type Payments } from './payments'

export type HttpRequest = {
  method: string
  path: string
  query: Record<string, string | undefined>
  headers: Record<string, string | undefined>
  body: unknown
  ip: string
}

export type HttpResponse = { status: number; body: unknown }

/** At most `limit` requests per key in any `windowMs`, counted over a sliding window. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body })

function orderItems(value: unknown): OrderItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    return undefined
  }
  const items: OrderItem[] = []
  for (const entry of value) {
    const item = entry as Partial<OrderItem> | null
    if (!item || typeof item.sku !== 'string' || !Number.isInteger(item.quantity)) {
      return undefined
    }
    items.push({ sku: item.sku, quantity: item.quantity as number })
  }
  return items
}

/** The storefront's HTTP routes. Every route needs the customer id the gateway authenticated. */
export function createRoutes(deps: { orders: Orders; payments: Payments; limiter: RateLimiter }) {
  async function listOrders(customerId: string, request: HttpRequest): Promise<HttpResponse> {
    const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1)
    const pageSize = Number.parseInt(request.query.limit ?? '20', 10)
    return json(200, await deps.orders.listForCustomer(customerId, page, pageSize))
  }

  async function placeOrder(customerId: string, request: HttpRequest): Promise<HttpResponse> {
    const body = (request.body ?? {}) as { currency?: unknown; items?: unknown }
    const items = orderItems(body.items)
    if (!isCurrency(body.currency) || !items) {
      return json(400, { error: 'currency and items are required' })
    }
    const order = await deps.orders.place(customerId, body.currency, items)
    try {
      const payment = await deps.payments.capture(order)
      return json(201, await deps.orders.markPaid(order.id, payment.id))
    } catch (error) {
      await deps.orders.cancel(order.id, 'payment failed')
      throw error
    }
  }

  async function refund(customerId: string, request: HttpRequest): Promise<HttpResponse> {
    const paymentId = request.path.split('/')[2] ?? ''
    const amount = (request.body as { amount?: unknown } | null)?.amount
    if (typeof amount !== 'string') {
      return json(400, { error: 'amount is required, as "12.34"' })
    }
    const payment = await deps.payments.get(paymentId)
    if (!payment || (await deps.orders.get(payment.orderId)).customerId !== customerId) {
      return json(404, { error: 'not found' })
    }
    return json(200, await deps.payments.refund(paymentId, parseCents(amount)))
  }

  return async function handle(request: HttpRequest): Promise<HttpResponse> {
    if (!deps.limiter.allow(request.ip)) {
      return json(429, { error: 'too many requests' })
    }
    const customerId = request.headers['x-customer-id']
    if (!customerId) {
      return json(401, { error: 'sign in first' })
    }
    try {
      if (request.method === 'GET' && request.path === '/orders') {
        return await listOrders(customerId, request)
      }
      if (request.method === 'POST' && request.path === '/orders') {
        return await placeOrder(customerId, request)
      }
      if (request.method === 'POST' && /^\/payments\/[^/]+\/refund$/.test(request.path)) {
        return await refund(customerId, request)
      }
      return json(404, { error: 'not found' })
    } catch (error) {
      if (error instanceof OutOfStockError) {
        return json(409, { error: error.message })
      }
      if (error instanceof PaymentDeclinedError) {
        return json(402, { error: error.message })
      }
      if (error instanceof OrderNotFoundError) {
        return json(404, { error: 'not found' })
      }
      if (error instanceof RangeError) {
        return json(400, { error: error.message })
      }
      return json(500, { error: 'internal error' })
    }
  }
}
