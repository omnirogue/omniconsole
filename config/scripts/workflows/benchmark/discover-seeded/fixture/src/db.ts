/**
 * Storage for the storefront service. Production backs each table with Postgres; tests and the
 * local sandbox use the in-memory tables below, which copy rows in and out like a real driver.
 */

export type Currency = 'USD' | 'EUR' | 'GBP'

export type StockRow = { sku: string; available: number; reserved: number }

export type ReservationRow = {
  id: string
  sku: string
  quantity: number
  orderId: string
  createdAt: number
}

export type OrderLine = { sku: string; quantity: number; unitCents: number }

export type OrderStatus = 'pending' | 'reserved' | 'paid' | 'cancelled' | 'failed'

export type OrderRow = {
  id: string
  customerId: string
  currency: Currency
  lines: OrderLine[]
  totalCents: number
  status: OrderStatus
  createdAt: number
  paymentId?: string
}

export type PaymentStatus = 'captured' | 'refunded' | 'failed'

export type PaymentRow = {
  id: string
  orderId: string
  currency: Currency
  capturedCents: number
  refundedCents: number
  status: PaymentStatus
}

export type Table<T> = {
  get(key: string): Promise<T | undefined>
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<T[]>
}

export class MemoryTable<T> implements Table<T> {
  private readonly rows = new Map<string, T>()

  constructor(private readonly latencyMs = 0) {}

  private async roundTrip(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs))
    }
  }

  async get(key: string): Promise<T | undefined> {
    await this.roundTrip()
    const row = this.rows.get(key)
    return row === undefined ? undefined : structuredClone(row)
  }

  async put(key: string, value: T): Promise<void> {
    await this.roundTrip()
    this.rows.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<void> {
    await this.roundTrip()
    this.rows.delete(key)
  }

  async list(): Promise<T[]> {
    await this.roundTrip()
    return [...this.rows.values()].map((row) => structuredClone(row))
  }
}

export type Db = {
  stock: Table<StockRow>
  reservations: Table<ReservationRow>
  orders: Table<OrderRow>
  payments: Table<PaymentRow>
}

export function memoryDb(latencyMs = 0): Db {
  return {
    stock: new MemoryTable<StockRow>(latencyMs),
    reservations: new MemoryTable<ReservationRow>(latencyMs),
    orders: new MemoryTable<OrderRow>(latencyMs),
    payments: new MemoryTable<PaymentRow>(latencyMs)
  }
}

let sequence = 0

/** Sortable, unique within this process: time first, then a counter. */
export function newId(prefix: string): string {
  sequence += 1
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36).padStart(4, '0')}`
}
