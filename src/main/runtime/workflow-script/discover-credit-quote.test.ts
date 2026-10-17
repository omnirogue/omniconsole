import { describe, expect, it, vi } from 'vitest'
import {
  checkDiscoverCreditBudgetGuard,
  quoteDiscoverRunCredits,
  type DiscoverCreditMode,
  type DiscoverCreditQuoteOptions
} from './discover-credit-quote'

const pricing = { creditsPerAgent: 0.25, maxCreditsPerAgent: 1 }
const account = () => ({
  status: vi.fn(async () => ({ state: 'linked' as const, apiOrigin: 'https://api.example.com' })),
  requireToken: vi.fn(async () => 'test-token')
})
function wallet(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
}

describe('Discover credit quote', () => {
  it('prices both Quick calls and rounds fractional credits up', async () => {
    const quote = await quoteDiscoverRunCredits('quick', pricing)
    expect(quote).toMatchObject({
      estimatedCredits: 1,
      maxReservationCredits: 2,
      quickMaxReservationCredits: 2,
      agentCalls: { low: 2, high: 2 },
      balance: null,
      balanceStatus: 'not-requested'
    })
  })

  it('uses bounded planner estimates for standard and deep', async () => {
    const standard = await quoteDiscoverRunCredits('standard', pricing)
    const deep = await quoteDiscoverRunCredits('deep', pricing)
    expect(standard.agentCalls.high).toBeLessThanOrEqual(160)
    expect(deep.agentCalls.high).toBeLessThanOrEqual(400)
    expect(standard.maxReservationCredits).toBeGreaterThan(2)
    expect(deep.maxReservationCredits).toBeGreaterThan(standard.maxReservationCredits)
    expect(deep.estimatedCredits).toBeLessThanOrEqual(deep.maxReservationCredits)
    const capped = await quoteDiscoverRunCredits('deep', {
      ...pricing,
      maxAgents: 10,
      lensCount: 1
    })
    expect(capped.maxReservationCredits).toBeLessThanOrEqual(10)
  })

  it('prices the Quick alternative independently', async () => {
    const quote = await quoteDiscoverRunCredits('deep', { ...pricing, quickMaxCreditsPerAgent: 5 })
    expect(quote.quickMaxReservationCredits).toBe(10)
    expect(checkDiscoverCreditBudgetGuard(quote, 3).recommendedAction).toBe('top-up')
    expect(checkDiscoverCreditBudgetGuard(quote, 10).recommendedAction).toBe('switch-to-quick')
  })

  it.each([
    { creditsPerAgent: -1 },
    { creditsPerAgent: Number.NaN },
    { maxCreditsPerAgent: Infinity },
    { maxCreditsPerAgent: 0.1 },
    { quickMaxCreditsPerAgent: -1 },
    { lensCount: 0 },
    { lensCount: 1.5 },
    { lensCount: 7 },
    { maxAgents: 5 },
    { maxAgents: 401 },
    { maxAgents: Number.NaN },
    { creditsPerAgent: Number.MAX_SAFE_INTEGER, maxCreditsPerAgent: Number.MAX_SAFE_INTEGER }
  ])('rejects invalid pricing or planner bounds: %j', async (overrides) => {
    await expect(quoteDiscoverRunCredits('standard', { ...pricing, ...overrides })).rejects.toThrow(
      RangeError
    )
  })

  it('rejects an unknown runtime mode and too few Quick calls', async () => {
    await expect(quoteDiscoverRunCredits('other' as DiscoverCreditMode, pricing)).rejects.toThrow(
      'mode'
    )
    await expect(quoteDiscoverRunCredits('quick', { ...pricing, maxAgents: 1 })).rejects.toThrow(
      'maxAgents'
    )
  })

  it('does not touch the account or network without an explicit balance check', async () => {
    const lease = account()
    const fetch = wallet({ availableCredits: 50 })
    await quoteDiscoverRunCredits('quick', { ...pricing, account: lease, fetch })
    expect(lease.status).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { availableCredits: 8, reservedCredits: 6 },
    { wallet: { spendableCredits: 8, availableCredits: 99, reservedCredits: 6 } },
    { ok: true, data: { wallet: { spendableCredits: 8, reservedCredits: 6 } } }
  ])('reads spendable credits without subtracting holds twice: %j', async (body) => {
    const fetch = wallet(body)
    const quote = await quoteDiscoverRunCredits('quick', {
      ...pricing,
      checkBalance: true,
      account: account(),
      fetch
    })
    expect(quote.balanceStatus).toBe('available')
    expect(quote.balance).toMatchObject({ availableCredits: 8, reservedCredits: 6 })
    expect(checkDiscoverCreditBudgetGuard(quote, quote.balance).allowed).toBe(true)
    const [url, request] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://api.example.com/api/omniconsole/wallet')
    expect(request).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer test-token' }
    })
    expect(request?.signal).toBeInstanceOf(AbortSignal)
  })

  it('requires linking before requesting credentials or a wallet', async () => {
    const lease: NonNullable<DiscoverCreditQuoteOptions['account']> = {
      status: vi.fn(async () => ({ state: 'unlinked' as const })),
      requireToken: vi.fn()
    }
    const fetch = wallet({ availableCredits: 50 })
    const quote = await quoteDiscoverRunCredits('quick', {
      ...pricing,
      checkBalance: true,
      account: lease,
      fetch
    })
    expect(quote.balanceStatus).toBe('connect-account')
    expect(lease.requireToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['http://api.example.com', 'https://user:password@api.example.com'])(
    'refuses unsafe credential destinations: %s',
    async (apiOrigin) => {
      const lease = account()
      lease.status.mockResolvedValue({ state: 'linked', apiOrigin })
      const fetch = wallet({ availableCredits: 50 })
      const quote = await quoteDiscoverRunCredits('quick', {
        ...pricing,
        checkBalance: true,
        account: lease,
        fetch
      })
      expect(quote.balanceStatus).toBe('unavailable')
      expect(lease.requireToken).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each([401, 403, 404, 429, 500])(
    'blocks on HTTP %i without losing the estimate',
    async (status) => {
      const response = new Response(JSON.stringify({ availableCredits: 999 }), { status })
      const cancel = vi.spyOn(response.body!, 'cancel')
      const quote = await quoteDiscoverRunCredits('quick', {
        ...pricing,
        checkBalance: true,
        account: account(),
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response)
      })
      expect(quote.balanceStatus).toBe(status === 401 ? 'connect-account' : 'unavailable')
      expect(quote.maxReservationCredits).toBe(2)
      expect(checkDiscoverCreditBudgetGuard(quote, quote.balance).allowed).toBe(false)
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it.each([
    null,
    {},
    { totalCredits: 100 },
    { availableCredits: -1 },
    { availableCredits: '100' },
    { ok: false, availableCredits: 100 }
  ])('rejects malformed wallet data: %j', async (body) => {
    const quote = await quoteDiscoverRunCredits('quick', {
      ...pricing,
      checkBalance: true,
      account: account(),
      fetch: wallet(body)
    })
    expect(quote.balance).toBeNull()
    expect(quote.balanceStatus).toBe('unavailable')
  })

  it('preserves the quote on a timeout, invalid JSON or credential failure', async () => {
    const requests = [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport details')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON'))
    ]
    for (const fetch of requests) {
      const quote = await quoteDiscoverRunCredits('quick', {
        ...pricing,
        checkBalance: true,
        account: account(),
        fetch
      })
      expect(quote.balanceStatus).toBe('unavailable')
      expect(checkDiscoverCreditBudgetGuard(quote, null).warningMessage).not.toContain('private')
    }
    const lease = account()
    lease.requireToken.mockRejectedValue(new Error('private credentials'))
    const fetch = wallet({ availableCredits: 100 })
    const quote = await quoteDiscoverRunCredits('quick', {
      ...pricing,
      checkBalance: true,
      account: lease,
      fetch
    })
    expect(quote.balanceStatus).toBe('unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Discover credit budget guard', () => {
  it('does not use a cached balance after authentication has failed', async () => {
    const quote = await quoteDiscoverRunCredits('quick', {
      ...pricing,
      checkBalance: true,
      account: account(),
      fetch: wallet({}, 401)
    })
    expect(checkDiscoverCreditBudgetGuard(quote, 100).allowed).toBe(false)
  })

  it('requires enough spendable credits for the reservation, not just the estimate', async () => {
    const quote = await quoteDiscoverRunCredits('quick', pricing)
    expect(checkDiscoverCreditBudgetGuard(quote, 1)).toMatchObject({
      allowed: false,
      shortfallCredits: 1,
      recommendedAction: 'top-up'
    })
    expect(checkDiscoverCreditBudgetGuard(quote, 2)).toEqual({
      allowed: true,
      shortfallCredits: 0,
      warningMessage: null,
      recommendedAction: 'proceed'
    })
    expect(checkDiscoverCreditBudgetGuard(quote, 100).allowed).toBe(true)
  })

  it('only recommends Quick when its full reservation fits', async () => {
    const quote = await quoteDiscoverRunCredits('standard', pricing)
    expect(checkDiscoverCreditBudgetGuard(quote, 2).recommendedAction).toBe('switch-to-quick')
    expect(checkDiscoverCreditBudgetGuard(quote, 1.5).recommendedAction).toBe('top-up')
    expect(checkDiscoverCreditBudgetGuard(quote, 0).shortfallCredits).toBe(
      quote.maxReservationCredits
    )
  })

  it.each([null, undefined, Number.NaN, Infinity, -1])(
    'never approves an unknown/invalid balance: %s',
    async (balance) => {
      const quote = await quoteDiscoverRunCredits('quick', pricing)
      expect(checkDiscoverCreditBudgetGuard(quote, balance)).toMatchObject({
        allowed: false,
        recommendedAction: 'connect-account'
      })
    }
  )

  it('fails closed on corrupted quotes and permits an explicitly free run with a known wallet', async () => {
    const quote = await quoteDiscoverRunCredits('quick', {
      creditsPerAgent: 0,
      maxCreditsPerAgent: 0
    })
    expect(checkDiscoverCreditBudgetGuard(quote, 0).allowed).toBe(true)
    expect(checkDiscoverCreditBudgetGuard(quote, null).allowed).toBe(false)
    expect(
      checkDiscoverCreditBudgetGuard({ ...quote, maxReservationCredits: Number.NaN }, 100).allowed
    ).toBe(false)
    expect(checkDiscoverCreditBudgetGuard({ ...quote, estimatedCredits: 1 }, 100).allowed).toBe(
      false
    )
  })
})
