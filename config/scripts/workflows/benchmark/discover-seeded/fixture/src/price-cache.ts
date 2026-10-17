import type { Currency } from './db'

export type PriceQuote = { sku: string; currency: Currency; unitCents: number; fetchedAt: number }

/** The pricing service: list price for a SKU in a currency, after regional adjustments. */
export type PriceSource = (sku: string, currency: Currency) => Promise<PriceQuote>

type Entry = { quote: PriceQuote; expiresAt: number; refreshing: boolean }

/** Quotes this close to expiry are served while a fresh one is fetched in the background. */
const SOFT_REFRESH_MS = 30_000

/**
 * Keeps price quotes for a few minutes so a checkout does not call the pricing service once per
 * line. A quote close to expiry is refreshed in the background while the old one is served.
 */
export class PriceCache {
  private readonly entries = new Map<string, Entry>()
  private hits = 0
  private misses = 0

  constructor(
    private readonly source: PriceSource,
    private readonly ttlSeconds = 300,
    private readonly now: () => number = Date.now
  ) {}

  private cacheKey(sku: string): string {
    return `price:${sku.trim().toUpperCase()}`
  }

  async get(sku: string, currency: Currency): Promise<PriceQuote> {
    const key = this.cacheKey(sku)
    const entry = this.entries.get(key)
    const now = this.now()
    if (entry && entry.expiresAt > now) {
      this.hits += 1
      if (entry.expiresAt - now < SOFT_REFRESH_MS && !entry.refreshing) {
        void this.refresh(key, sku, currency)
      }
      return entry.quote
    }
    this.misses += 1
    const quote = await this.source(sku, currency)
    this.store(key, quote)
    return quote
  }

  private store(key: string, quote: PriceQuote): void {
    this.entries.set(key, {
      quote,
      expiresAt: this.now() + this.ttlSeconds,
      refreshing: false
    })
  }

  private async refresh(key: string, sku: string, currency: Currency): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) {
      return
    }
    entry.refreshing = true
    try {
      this.store(key, await this.source(sku, currency))
    } catch {
      // Keep serving the quote we have until it expires; the next read retries.
      entry.refreshing = false
    }
  }

  invalidate(sku: string): void {
    this.entries.delete(this.cacheKey(sku))
  }

  clear(): void {
    this.entries.clear()
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.entries.size, hits: this.hits, misses: this.misses }
  }
}
