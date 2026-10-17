import { describe, expect, it } from 'vitest'
import { scorecardDocument } from './console-scorecard-contract'
import { providerBills } from './console-scorecard-provider-bills'

/**
 * Provider bills beside the logged API cost (Sal, 2026-09-29: "Show provider bills
 * in omniIDE"). The block is estate-wide and optional, so the rules are: absent
 * stays absent, a malformed block never takes the document down with it, and a
 * figure nobody read decodes as null — never as 0.
 */

function day(date: string, partial: boolean) {
  return {
    date,
    partial,
    billed: {
      openrouter_app: 1032.16,
      openrouter_other: 201.23,
      fal: 453.52,
      byteplus: null,
      google: null,
      openai: null,
      anthropic: null
    },
    piapi_topups: 0,
    billed_known_usd: 1485.68,
    logged: {
      openrouter: 691.13,
      fal: 330.97,
      byteplus: 818.2,
      piapi: 13.44,
      other: 12.68,
      total: 1866.42
    },
    unlogged_known: { openrouter: 341.03, fal: 122.55 }
  }
}

const FULL = {
  basis: 'vendor meters for UTC days; logged = OmniRogue + BetaCorp api_cost_log',
  timezone: 'UTC',
  not_connected: ['byteplus', 'google', 'openai', 'anthropic'],
  days: [
    ...['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map(
      (date) => day(date, false)
    ),
    day('2026-09-28', true)
  ]
}

function document(extra: Record<string, unknown> = {}) {
  return scorecardDocument.parse({
    generated_at: '2026-09-28T12:00:00Z',
    today: '2026-09-28',
    companies: [],
    ...extra
  })
}

describe('the provider bills block', () => {
  it('decodes the full payload with every vendor meter', () => {
    const bills = document({ provider_bills: FULL }).provider_bills!
    expect(bills.timezone).toBe('UTC')
    expect(bills.basis).toContain('api_cost_log')
    expect(bills.not_connected).toEqual(['byteplus', 'google', 'openai', 'anthropic'])
    expect(bills.days).toHaveLength(7)
    expect(bills.days[5]).toMatchObject({
      date: '2026-09-27',
      partial: false,
      billed_known_usd: 1485.68,
      piapi_topups: 0
    })
    expect(bills.days[5].billed.fal).toBe(453.52)
    expect(bills.days[5].logged).toMatchObject({ total: 1866.42, byteplus: 818.2 })
    expect(bills.days[5].unlogged_known).toEqual({ openrouter: 341.03, fal: 122.55 })
    expect(bills.days[6].partial).toBe(true)
  })

  it('stays absent when the relay dropped the key for a company-scoped reader', () => {
    expect(document().provider_bills).toBeUndefined()
    expect(document({ provider_bills: null }).provider_bills).toBeNull()
  })

  it('keeps an unread figure null, never zero', () => {
    const bills = document({
      provider_bills: {
        days: [
          {
            date: '2026-09-27',
            partial: false,
            billed: { openrouter_app: null, byteplus: null },
            billed_known_usd: null,
            logged: null,
            unlogged_known: { openrouter: null, fal: 'n/a' }
          }
        ]
      }
    }).provider_bills!
    const [only] = bills.days
    expect(only.billed).toEqual({ openrouter_app: null, byteplus: null })
    expect(only.billed_known_usd).toBeNull()
    expect(only.piapi_topups).toBeNull()
    expect(only.logged).toBeNull()
    expect(only.unlogged_known).toEqual({ openrouter: null, fal: null })
    // A block that omits them still has a clock and no vendor list.
    expect(bills.timezone).toBe('UTC')
    expect(bills.not_connected).toEqual([])
    expect(bills.basis).toBeNull()
  })

  it('reads a figure the collector sent as text, as every other scorecard leaf does', () => {
    const bills = providerBills.parse({
      days: [{ date: '2026-09-27', partial: false, billed_known_usd: '12.5', billed: { fal: '3' } }]
    })
    expect(bills.days[0].billed_known_usd).toBe(12.5)
    expect(bills.days[0].billed.fal).toBe(3)
  })

  it('drops a malformed block or row instead of failing the whole document', () => {
    for (const broken of ['broken', 7, [1, 2], true]) {
      const parsed = scorecardDocument.safeParse({
        generated_at: '2026-09-28T12:00:00Z',
        today: '2026-09-28',
        companies: [],
        provider_bills: broken
      })
      expect(parsed.success, String(broken)).toBe(true)
      expect(parsed.success && parsed.data.provider_bills, String(broken)).toBeNull()
    }
    const odd = providerBills.parse({
      basis: 42,
      timezone: '',
      not_connected: 'google',
      days: [
        null,
        'x',
        { partial: false },
        { date: '2026-09-27', billed: 7, logged: [], unlogged_known: 'n/a', billed_known_usd: {} }
      ]
    })
    expect(odd.basis).toBeNull()
    expect(odd.timezone).toBe('UTC')
    expect(odd.not_connected).toEqual([])
    expect(odd.days).toHaveLength(1)
    // A day that does not say it is complete is treated as partial.
    expect(odd.days[0]).toMatchObject({
      date: '2026-09-27',
      partial: true,
      billed: {},
      billed_known_usd: null,
      logged: null,
      unlogged_known: null
    })
  })
})
