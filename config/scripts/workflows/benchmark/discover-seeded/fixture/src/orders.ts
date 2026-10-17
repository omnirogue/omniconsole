import { newId, type Currency, type Db, type OrderLine, type OrderRow } from './db'
import type { Inventory } from './inventory'
import { orderTotal } from './money'
import type { PriceCache } from './price-cache'

export type OrderEvent =
  | { type: 'order.reserved'; orderId: string }
  | { type: 'order.paid'; orderId: string; paymentId: string }
  | { type: 'order.cancelled'; orderId: string; reason: string }

export type OrderItem = { sku: string; quantity: number }

export type OrderPage = { orders: OrderRow[]; total: number; page: number; pageSize: number }

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`No order ${orderId}`)
  }
}

/**
 * Checkout: prices every line, records the order, reserves its stock, and moves it through
 * paid or cancelled. Every state change is written before the event that announces it.
 */
export class Orders {
  constructor(
    private readonly db: Db,
    private readonly inventory: Inventory,
    private readonly prices: PriceCache,
    private readonly publish: (event: OrderEvent) => void,
    private readonly now: () => number = Date.now
  ) {}

  async place(customerId: string, currency: Currency, items: OrderItem[]): Promise<OrderRow> {
    if (items.length === 0) {
      throw new RangeError('An order needs at least one item')
    }
    const lines: OrderLine[] = []
    for (const item of items) {
      const quote = await this.prices.get(item.sku, currency)
      lines.push({ sku: item.sku, quantity: item.quantity, unitCents: quote.unitCents })
    }
    const order: OrderRow = {
      id: newId('ord'),
      customerId,
      currency,
      lines,
      totalCents: orderTotal(lines),
      status: 'pending',
      createdAt: this.now()
    }
    await this.db.orders.put(order.id, order)
    try {
      for (const line of lines) {
        this.inventory.reserve(line.sku, line.quantity, order.id)
      }
      order.status = 'reserved'
    } catch (error) {
      order.status = 'failed'
      await this.db.orders.put(order.id, order)
      await this.releaseAll(order.id)
      throw error
    }
    await this.db.orders.put(order.id, order)
    this.publish({ type: 'order.reserved', orderId: order.id })
    return order
  }

  async get(orderId: string): Promise<OrderRow> {
    const order = await this.db.orders.get(orderId)
    if (!order) {
      throw new OrderNotFoundError(orderId)
    }
    return order
  }

  async markPaid(orderId: string, paymentId: string): Promise<OrderRow> {
    const order = await this.get(orderId)
    if (order.status !== 'reserved') {
      throw new Error(`Order ${orderId} is ${order.status}, not awaiting payment`)
    }
    for (const reservation of await this.inventory.reservationsFor(orderId)) {
      await this.inventory.commit(reservation.id)
    }
    const paid: OrderRow = { ...order, status: 'paid', paymentId }
    await this.db.orders.put(orderId, paid)
    this.publish({ type: 'order.paid', orderId, paymentId })
    return paid
  }

  async cancel(orderId: string, reason: string): Promise<OrderRow> {
    const order = await this.get(orderId)
    if (order.status === 'paid') {
      throw new Error('A paid order is refunded, not cancelled')
    }
    if (order.status === 'cancelled') {
      return order
    }
    await this.releaseAll(orderId)
    const cancelled: OrderRow = { ...order, status: 'cancelled' }
    await this.db.orders.put(orderId, cancelled)
    this.publish({ type: 'order.cancelled', orderId, reason })
    return cancelled
  }

  private async releaseAll(orderId: string): Promise<void> {
    for (const reservation of await this.inventory.reservationsFor(orderId)) {
      await this.inventory.release(reservation.id)
    }
  }

  /** A customer's orders, newest first, `pageSize` to a page; pages are numbered from 1. */
  async listForCustomer(customerId: string, page = 1, pageSize = 20): Promise<OrderPage> {
    const all = (await this.db.orders.list())
      .filter((order) => order.customerId === customerId)
      .sort((left, right) => right.createdAt - left.createdAt)
    const start = (page - 1) * pageSize
    return {
      orders: all.slice(start, start + pageSize - 1),
      total: all.length,
      page,
      pageSize
    }
  }
}
