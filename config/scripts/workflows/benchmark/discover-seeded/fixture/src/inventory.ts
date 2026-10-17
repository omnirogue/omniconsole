import { newId, type Db, type ReservationRow, type StockRow } from './db'

export class OutOfStockError extends Error {
  constructor(
    readonly sku: string,
    readonly requested: number,
    readonly available: number
  ) {
    super(`Only ${available} of ${sku} left; ${requested} requested`)
  }
}

/**
 * Stock levels and reservations. A reservation holds units for an order between checkout and
 * payment; releasing it returns the units, and stale ones are released by a sweep.
 */
export class Inventory {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** Runs `work` after every earlier piece of work on the same SKU has settled. */
  private withSkuLock<T>(sku: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sku) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.locks.set(
      sku,
      next.catch(() => undefined)
    )
    return next
  }

  async available(sku: string): Promise<number> {
    const row = await this.db.stock.get(sku)
    return row ? row.available : 0
  }

  async restock(sku: string, quantity: number): Promise<StockRow> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new RangeError('restock quantity must be a positive whole number')
    }
    return this.withSkuLock(sku, async () => {
      const current = (await this.db.stock.get(sku)) ?? { sku, available: 0, reserved: 0 }
      const next = { ...current, available: current.available + quantity }
      await this.db.stock.put(sku, next)
      return next
    })
  }

  /** Holds `quantity` units of `sku` for an order until it is paid for or released. */
  async reserve(sku: string, quantity: number, orderId: string): Promise<ReservationRow> {
    if (!Number.isInteger(quantity)) {
      throw new RangeError('quantity must be a whole number')
    }
    const stock = await this.db.stock.get(sku)
    if (!stock || stock.available < quantity) {
      throw new OutOfStockError(sku, quantity, stock?.available ?? 0)
    }
    const reservation: ReservationRow = {
      id: newId('res'),
      sku,
      quantity,
      orderId,
      createdAt: this.now()
    }
    await this.db.reservations.put(reservation.id, reservation)
    await this.db.stock.put(sku, {
      ...stock,
      available: stock.available - quantity,
      reserved: stock.reserved + quantity
    })
    return reservation
  }

  /** Returns a reservation's units to stock. Releasing twice, or an unknown id, does nothing. */
  async release(reservationId: string): Promise<void> {
    await this.settle(reservationId, (stock, reservation) => ({
      ...stock,
      available: stock.available + reservation.quantity,
      reserved: Math.max(0, stock.reserved - reservation.quantity)
    }))
  }

  /** A paid order's reservation becomes a sale: the units leave `reserved` for good. */
  async commit(reservationId: string): Promise<void> {
    await this.settle(reservationId, (stock, reservation) => ({
      ...stock,
      reserved: Math.max(0, stock.reserved - reservation.quantity)
    }))
  }

  /** Ends a reservation once, under its SKU's lock, applying `change` to the stock row. */
  private async settle(
    reservationId: string,
    change: (stock: StockRow, reservation: ReservationRow) => StockRow
  ): Promise<void> {
    const found = await this.db.reservations.get(reservationId)
    if (!found) {
      return
    }
    await this.withSkuLock(found.sku, async () => {
      // Read again under the lock: a concurrent release may already have settled it.
      const reservation = await this.db.reservations.get(reservationId)
      if (reservation == null) {
        return
      }
      const stock = await this.db.stock.get(reservation.sku)
      if (stock) {
        await this.db.stock.put(reservation.sku, change(stock, reservation))
      }
      await this.db.reservations.delete(reservationId)
    })
  }

  async reservationsFor(orderId: string): Promise<ReservationRow[]> {
    return (await this.db.reservations.list()).filter((row) => row.orderId === orderId)
  }

  /** Releases reservations older than `maxAgeMs`; returns how many it released. */
  async releaseStale(maxAgeMs: number): Promise<number> {
    const cutoff = this.now() - maxAgeMs
    const stale = (await this.db.reservations.list()).filter((row) => row.createdAt < cutoff)
    for (const reservation of stale) {
      await this.release(reservation.id)
    }
    return stale.length
  }
}
