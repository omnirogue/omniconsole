import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteDiscoverCredits } from './discover-credit-quote'

const { status, requireToken } = vi.hoisted(() => ({
  status: vi.fn(async () => ({ state: 'linked', apiOrigin: 'https://api.example.test' })),
  requireToken: vi.fn(async () => 'test-token')
}))
vi.mock('../../omnirogue-account/omnirogue-account-lease', () => ({
  getSharedOmniRogueAccountLease: () => ({ status, requireToken })
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Discover IPC quote adapter', () => {
  const pricing = { creditsPerAgent: 2, maxCreditsPerAgent: 5 }

  it('starts an unpriced run from a linked wallet with credits, without an estimate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ spendableCredits: 49 })))
    )
    const result = await quoteDiscoverCredits({ mode: 'quick', agentCalls: 1 })
    expect(result.quote).toBeNull()
    expect(result.guard).toMatchObject({
      allowed: true,
      recommendedAction: 'proceed',
      warningMessage: expect.stringContaining('no estimate')
    })
  })

  it('keeps an unpriced run blocked on an empty wallet or an unlinked account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ spendableCredits: 0 })))
    )
    expect((await quoteDiscoverCredits({ mode: 'quick' })).guard).toMatchObject({
      allowed: false,
      recommendedAction: 'top-up'
    })
    status.mockResolvedValueOnce({ state: 'unlinked', apiOrigin: 'https://api.example.test' })
    expect((await quoteDiscoverCredits({ mode: 'quick' })).guard).toMatchObject({
      allowed: false,
      recommendedAction: 'connect-account'
    })
  })

  it('keeps an unpriced run blocked when the wallet cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    expect((await quoteDiscoverCredits({ mode: 'standard' })).guard?.allowed).toBe(false)
  })

  it('quotes the graph call ceiling and checks the live spendable balance', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ spendableCredits: 49 })))
    vi.stubGlobal('fetch', fetch)
    const result = await quoteDiscoverCredits({ mode: 'standard', pricing, agentCalls: 10 })
    expect(result.quote).toMatchObject({
      estimatedCredits: 20,
      maxReservationCredits: 50,
      balanceStatus: 'available',
      agentCalls: { low: 10, high: 10 }
    })
    expect(result.guard).toMatchObject({ allowed: false, shortfallCredits: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('includes optional Quick verification calls instead of assuming two calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ availableCredits: 200 })))
    )
    const result = await quoteDiscoverCredits({ mode: 'quick', pricing, agentCalls: 21 })
    expect(result.quote?.maxReservationCredits).toBe(105)
    expect(result.guard?.allowed).toBe(true)
  })

  it('keeps a wallet failure blocked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    const result = await quoteDiscoverCredits({ mode: 'quick', pricing, agentCalls: 1 })
    expect(result.quote?.balanceStatus).toBe('unavailable')
    expect(result.guard?.allowed).toBe(false)
  })

  it.each([
    { checkBalance: false },
    { account: { apiOrigin: 'https://untrusted.example' } },
    { agentCalls: 0 },
    { pricing: { creditsPerAgent: -1, maxCreditsPerAgent: 5 } }
  ])('rejects unsafe or invalid renderer options: %j', async (extra) => {
    await expect(quoteDiscoverCredits({ mode: 'quick', pricing, ...extra })).rejects.toThrow()
    expect(status).not.toHaveBeenCalled()
  })
})
