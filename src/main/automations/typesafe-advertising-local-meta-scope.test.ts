import { describe, expect, it } from 'vitest'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import { META_IDS, META_NOW, metaFixture, metaTarget, mockMetaFetch } from './local-meta-fixtures'

const identity = { token: 'fixture-only-token', isCurrent: () => true }
const now = () => META_NOW
const target = metaTarget()
const invalidTargets: [string, AdvertisingTarget[]][] = [
  ['empty selection', []],
  ['more than 20 targets', Array.from({ length: 21 }, () => target)],
  ['duplicate target', [target, target]],
  ['wrong account', [{ ...target, accountId: 'act_999999' }]],
  ['wrong company', [{ ...target, company: 'betacorp' }]],
  ['inconsistent ad-set ID', [{ ...target, adsetId: '999999' }]],
  [
    'campaign target',
    [{ ...target, objectType: 'campaign', nativeId: META_IDS.campaign, adsetId: null }]
  ]
]

describe('local Meta native scope fences', () => {
  it.each(invalidTargets)('refuses %s before network access', async (_label, candidates) => {
    const fetch = mockMetaFetch()
    await expect(fetchLocalMetaEvidence(candidates, identity, { fetch, now })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['account', 'id', 'act_999999'],
    ['account', 'account_id', '999999'],
    ['campaign', 'account_id', '999999'],
    ['adset', 'account_id', '999999'],
    ['ad', 'account_id', '999999'],
    ['campaign', 'id', '999999'],
    ['adset', 'campaign_id', '999999'],
    ['ad', 'campaign_id', '999999'],
    ['ad', 'adset_id', '999999']
  ] as const)('refuses initial %s.%s mismatch', async (node, field, value) => {
    const fixture = metaFixture()
    fixture[node][field] = value
    await expect(
      fetchLocalMetaEvidence([metaTarget('ad')], identity, { fetch: mockMetaFetch(fixture), now })
    ).rejects.toThrow(/scope|hierarchy|metadata/)
  })

  it.each([
    ['campaign', 'daily_budget', -1],
    ['campaign', 'lifetime_budget', 1.5],
    ['adset', 'daily_budget', '-1'],
    ['adset', 'daily_budget', '12.34'],
    ['adset', 'lifetime_budget', 'unknown'],
    ['adset', 'daily_budget', Number.MAX_SAFE_INTEGER + 1]
  ] as const)('rejects malformed native %s.%s budget %s', async (node, field, value) => {
    const fixture = metaFixture()
    fixture[node][field] = value
    await expect(
      fetchLocalMetaEvidence([target], identity, { fetch: mockMetaFetch(fixture), now })
    ).rejects.toThrow('native control or account scope is invalid')
  })

  it('rejects an account timezone that cannot define today', async () => {
    const fixture = metaFixture()
    fixture.account.timezone_name = 'Invalid/Timezone'
    await expect(
      fetchLocalMetaEvidence([target], identity, { fetch: mockMetaFetch(fixture), now })
    ).rejects.toThrow('timezone is unavailable')
  })

  it.each([
    ['account_id', '999999'],
    ['campaign_id', '999999'],
    ['adset_id', '999999'],
    ['date_start', '2026-09-19'],
    ['date_stop', '2026-09-21']
  ])(
    'refuses insight %s mismatch instead of accepting unrelated statistics',
    async (field, value) => {
      const fixture = metaFixture()
      fixture.insight[field] = value
      await expect(
        fetchLocalMetaEvidence([target], identity, { fetch: mockMetaFetch(fixture), now })
      ).rejects.toThrow(/hierarchy|account date/)
    }
  )

  it('refuses duplicate insight rows across pages after completing bounded pagination', async () => {
    const fixture = metaFixture()
    const fetch = mockMetaFetch(fixture, (body, { path, visit, url }) => {
      if (!path.endsWith('/insights') || visit !== 1) {
        return body
      }
      const next = new URL(url)
      next.searchParams.set('after', 'fixture-cursor')
      return { ...body, paging: { cursors: { after: 'fixture-cursor' }, next: next.href } }
    })
    await expect(fetchLocalMetaEvidence([target], identity, { fetch, now })).rejects.toThrow(
      'duplicate or unexpected rows'
    )
    expect(
      fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith('/insights'))
    ).toHaveLength(2)
  })

  it('does not return partial evidence when a later selected object has mismatched insights', async () => {
    const fetch = mockMetaFetch(metaFixture(), (body, { path }) =>
      path === `${META_IDS.ad}/insights`
        ? { data: [{ ...metaFixture().insight, ad_id: '999999' }] }
        : body
    )
    await expect(
      fetchLocalMetaEvidence([target, metaTarget('ad')], identity, { fetch, now })
    ).rejects.toThrow('exact native target hierarchy')
  })
})
