import { describe, expect, it } from 'vitest'
import { creditsExhaustedSchema, parseCreditWallet } from './omni-credits'

describe('CreditWallet contract', () => {
  it('tolerates missing display fields without inventing usage or admin access', () => {
    expect(parseCreditWallet({ enabled: true, balance: 42, future: 'ignored' })).toEqual({
      enabled: true,
      balance: 42,
      unit: 'credit',
      upgrade: { url: '', next_plan: null, can_upgrade: false }
    })
  })
  it('hides disabled and malformed wallets instead of reporting zero', () => {
    for (const value of [
      null,
      {},
      { enabled: false, balance: 1 },
      { enabled: true },
      { enabled: true, balance: -1 },
      { enabled: true, balance: Number.NaN }
    ]) {
      expect(parseCreditWallet(value)).toBeNull()
    }
  })
  it('retains server-authorized team usage and upgrade copy', () => {
    const payload = {
      enabled: true,
      balance: 0,
      members: [{ actor: 'a', name: 'Sal', spent: 12 }],
      upgrade: {
        can_upgrade: true,
        url: 'https://app.omnisi.ai/billing',
        next_plan: { name: 'Pro', price: '$299', monthly_credits: 15000 }
      }
    }
    const wallet = parseCreditWallet(payload)
    expect(wallet?.members?.[0].spent).toBe(12)
    expect(wallet?.upgrade.next_plan?.price).toBe('$299')
  })
  it('accepts the structured insufficient-credit error with a positive balance', () => {
    expect(
      creditsExhaustedSchema.safeParse({ error: 'credits_exhausted', needed: 576, balance: 40 })
        .success
    ).toBe(true)
    expect(creditsExhaustedSchema.safeParse({ error: 'other', balance: 40 }).success).toBe(false)
  })
})

it.each([
  'http://billing.test/upgrade',
  '/billing',
  '//billing.test',
  'javascript:alert(1)',
  'data:text/plain,x',
  'bad',
  null
])('drops unsafe CTA %s without dropping wallet or event data', (url) => {
  const upgrade = { url, can_upgrade: true, next_plan: { id: 'plus', name: 'Plus' } }
  const wallet = parseCreditWallet({
    enabled: true,
    balance: 42,
    members: [{ name: 'Sal' }],
    upgrade
  })
  expect(wallet).toMatchObject({ balance: 42, members: [{ name: 'Sal' }], upgrade: { url: '' } })
  expect(
    creditsExhaustedSchema.parse({ error: 'credits_exhausted', needed: 1, balance: 0, upgrade })
      .upgrade.url
  ).toBe('')
})

it('accepts contact, interval and setup_price on next_plan and rejects malformed', () => {
  const mk = (next_plan: unknown) => ({
    enabled: true,
    balance: 1,
    upgrade: { can_upgrade: true, url: 'https://x.test', next_plan }
  })
  expect(
    parseCreditWallet(mk({ id: 'enterprise', name: 'Enterprise', contact: true }))?.upgrade
      .next_plan?.contact
  ).toBe(true)
  expect(
    parseCreditWallet(mk({ name: 'E', interval: 'once', setup_price: '$2,500' }))?.upgrade.next_plan
      ?.interval
  ).toBe('once')
  expect(parseCreditWallet(mk({ name: 'E', interval: 'year' }))).toBeNull()
  expect(parseCreditWallet(mk({ name: 'E', contact: 'yes' }))).toBeNull()
})
