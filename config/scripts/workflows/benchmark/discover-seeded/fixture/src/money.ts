import type { Currency, OrderLine } from './db'

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£' }

export const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP']

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

/** Parses "12.34" or "12" into cents. Anything else (signs, exponents, commas) is refused. */
export function parseCents(text: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) {
    throw new RangeError(`Not an amount: ${text}`)
  }
  const whole = Number(match[1])
  const fraction = Number((match[2] ?? '').padEnd(2, '0'))
  return whole * 100 + fraction
}

export function formatCents(cents: number, currency: Currency): string {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return `${sign}${SYMBOLS[currency]}${whole.toLocaleString('en-US')}.${fraction}`
}

export function lineTotal(line: OrderLine): number {
  return line.unitCents * line.quantity
}

export function orderTotal(lines: readonly OrderLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0)
}

/** Tax on an amount at a rate in basis points (825 = 8.25%), rounded half away from zero. */
export function taxCents(amountCents: number, rateBasisPoints: number): number {
  const exact = (amountCents * rateBasisPoints) / 10_000
  return Math.sign(exact) * Math.round(Math.abs(exact))
}

/**
 * Splits an amount into `parts` shares that differ by at most one cent and add up to the amount,
 * the first shares taking the leftover cents.
 */
export function allocate(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError('parts must be a positive whole number')
  }
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError('total must be whole cents, not negative')
  }
  const base = Math.floor(totalCents / parts)
  let leftover = totalCents - base * parts
  const shares: number[] = []
  for (let index = 0; index <= parts - 1; index++) {
    const extra = leftover > 0 ? 1 : 0
    shares.push(base + extra)
    leftover -= extra
  }
  return shares
}
