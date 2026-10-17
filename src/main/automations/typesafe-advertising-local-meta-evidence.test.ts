import { describe, expect, it } from 'vitest'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import {
  META_ACCOUNT_ID,
  META_IDS,
  META_NOW,
  metaFixture,
  metaTarget,
  mockMetaFetch
} from './local-meta-fixtures'

const identity = { token: 'fixture-only-token', isCurrent: () => true }
const now = () => META_NOW

describe('local Meta selected-object evidence', () => {
  it.each(['adset', 'ad'] as const)(
    'projects provisional today %s evidence without inventing provider measurement time',
    async (type) => {
      const target = metaTarget(type)
      const fetch = mockMetaFetch()
      const [result] = await fetchLocalMetaEvidence([target], identity, { fetch, now })

      expect(result).toMatchObject({
        source: 'local.meta.graph',
        target,
        name: type === 'ad' ? 'Observed ad' : 'Observed ad set',
        currency: 'USD',
        status: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        measuredAt: null,
        observation: {
          freshnessBasis: 'completed_native_read',
          collectedAt: new Date(META_NOW).toISOString(),
          providerComputedAt: null,
          dayFinalized: false,
          attributionFinalized: false
        },
        fetchedAt: new Date(META_NOW).toISOString(),
        dateStart: '2026-09-20',
        dateStop: '2026-09-20',
        timezone: 'America/Panama',
        leadEvent: 'offsite_conversion.fb_pixel_lead',
        budgetOwnerId: META_IDS.adset,
        metrics: {
          spend: 25,
          revenue: 100,
          purchases: 2,
          registrations: 4,
          leads: 3,
          addToCarts: 6,
          checkouts: 5,
          linkClicks: 10,
          impressions: 1000,
          dailyBudget: 50,
          linkCpc: 2.5,
          roas: 4
        }
      })
      expect(result.limitations).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Today is provisional/),
          expect.stringMatching(/provider computation timestamp and attribution lag are unknown/)
        ])
      )
      expect(fetch).toHaveBeenCalledTimes(type === 'ad' ? 9 : 7)
      expect(result.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining('not full routine optimization evidence')])
      )
      for (const [input, init] of fetch.mock.calls) {
        const url = new URL(String(input))
        expect(url.origin).toBe('https://graph.facebook.com')
        expect(url.pathname).toMatch(/^\/v21\.0\//)
        expect(url.searchParams.has('access_token')).toBe(false)
        expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' })
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-only-token')
        if (url.pathname.endsWith('/insights')) {
          expect(Object.fromEntries(url.searchParams)).toMatchObject({
            date_preset: 'today',
            level: type,
            time_increment: 'all_days'
          })
        }
      }
    }
  )

  it('separates insight collection and final retrieval times while provider measurement remains unknown', async () => {
    let clock = META_NOW
    let collectedAt = ''
    const fetch = mockMetaFetch(metaFixture(), (body, { path }) => {
      clock += 1000
      if (path.endsWith('/insights')) {
        collectedAt = new Date(clock).toISOString()
      }
      return body
    })
    const [result] = await fetchLocalMetaEvidence([metaTarget()], identity, {
      fetch,
      now: () => clock
    })
    expect(result.measuredAt).toBeNull()
    expect(result.observation).toEqual({
      freshnessBasis: 'completed_native_read',
      collectedAt,
      providerComputedAt: null,
      dayFinalized: false,
      attributionFinalized: false
    })
    expect(result.fetchedAt).toBe(new Date(clock).toISOString())
    expect(Date.parse(result.fetchedAt)).toBeGreaterThan(Date.parse(collectedAt))
  })

  it.each([-86_400_000, 0, 86_400_000])(
    'never treats an HTTP Date header offset by %s ms as provider measurement time',
    async (offset) => {
      const fetch = mockMetaFetch(metaFixture(), undefined, {
        Date: new Date(META_NOW + offset).toUTCString()
      })
      const [result] = await fetchLocalMetaEvidence([metaTarget()], identity, { fetch, now })

      expect(result.measuredAt).toBeNull()
      expect(result.observation).toMatchObject({
        freshnessBasis: 'completed_native_read',
        collectedAt: new Date(META_NOW).toISOString(),
        providerComputedAt: null,
        dayFinalized: false,
        attributionFinalized: false
      })
      expect(result.fetchedAt).toBe(new Date(META_NOW).toISOString())
    }
  )

  it('inherits the campaign budget owner without attributing the budget to an ad', async () => {
    const fixture = metaFixture()
    fixture.campaign.daily_budget = '4500'
    fixture.adset.daily_budget = '0'
    const [result] = await fetchLocalMetaEvidence([metaTarget('ad')], identity, {
      fetch: mockMetaFetch(fixture),
      now
    })
    expect(result.budgetOwnerId).toBe(META_IDS.campaign)
    expect(result.metrics.dailyBudget).toBe(45)
  })

  it('shares ancestor reads across selected native objects but observes each insight independently', async () => {
    const fetch = mockMetaFetch()
    const targets = [metaTarget(), metaTarget('ad')]
    const results = await fetchLocalMetaEvidence(targets, identity, { fetch, now })
    expect(results.map((result) => result.target)).toEqual(targets)
    expect(fetch).toHaveBeenCalledTimes(10)
    const paths = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)
    for (const id of [META_ACCOUNT_ID, ...Object.values(META_IDS)]) {
      expect(paths.filter((path) => path === `/v21.0/${id}`)).toHaveLength(2)
    }
  })

  it('retains unknown performance values when no insight row is returned', async () => {
    const fetch = mockMetaFetch(metaFixture(), (body, { path }) =>
      path.endsWith('/insights') ? { data: [] } : body
    )
    const [result] = await fetchLocalMetaEvidence([metaTarget()], identity, { fetch, now })
    expect(result.metrics.dailyBudget).toBe(50)
    expect(
      Object.entries(result.metrics)
        .filter(([key]) => key !== 'dailyBudget')
        .every(([, value]) => value === null)
    ).toBe(true)
    expect(result.leadEvent).toBeNull()
    expect(result.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining('no today insight row')])
    )
  })

  it.each(['non-USD', 'lifetime', 'missing'] as const)(
    'keeps a %s daily budget unknown',
    async (kind) => {
      const fixture = metaFixture()
      if (kind === 'non-USD') {
        fixture.account.currency = 'JPY'
      }
      if (kind !== 'non-USD') {
        fixture.adset.daily_budget = '0'
      }
      if (kind === 'lifetime') {
        fixture.adset.lifetime_budget = '50000'
      }
      const [result] = await fetchLocalMetaEvidence([metaTarget()], identity, {
        fetch: mockMetaFetch(fixture),
        now
      })
      expect(result.metrics.dailyBudget).toBeNull()
      expect(result.budgetOwnerId).toBe(kind === 'missing' ? null : META_IDS.adset)
      expect(result.metrics.spend).toBe(25)
    }
  )

  it('rejects conflicting campaign and ad-set budget ownership', async () => {
    const fixture = metaFixture()
    fixture.campaign.daily_budget = '4500'
    await expect(
      fetchLocalMetaEvidence([metaTarget()], identity, { fetch: mockMetaFetch(fixture), now })
    ).rejects.toThrow('budget ownership is ambiguous')
  })
})
