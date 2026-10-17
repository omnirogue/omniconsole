import { describe, expect, it, vi } from 'vitest'
import { fetchLocalMetaEvidence } from './typesafe-advertising-local-meta-evidence'
import {
  META_ACCOUNT_ID,
  META_IDS,
  META_NOW,
  metaFixture,
  metaTarget,
  mockMetaFetch
} from './local-meta-fixtures'

const identity = () => ({ token: 'fixture-only-token', isCurrent: () => true })
const changedId = '120000000000999'

function finalAuthorization(check: () => void, fixture = metaFixture()) {
  let finalAccountRead = false
  let rechecks = 0
  const finalAssertion = vi.fn(check)
  const fetch = mockMetaFetch(fixture, (body, { path, visit }) => {
    if (path === META_ACCOUNT_ID && visit === 2) {
      finalAccountRead = true
    }
    return body
  })
  const assertCurrent = vi.fn(async () => {
    // Two transport rechecks precede the evidence-level final assertion.
    if (finalAccountRead && ++rechecks === 3) {
      finalAssertion()
    }
  })
  return { fetch, assertCurrent, finalAssertion }
}

describe('local Meta observation readback', () => {
  it.each([
    ['campaign', 'daily_budget', '19001'],
    ['campaign', 'lifetime_budget', '19001'],
    ['campaign', 'status', 'PAUSED'],
    ['campaign', 'account_id', changedId],
    ['adset', 'daily_budget', '19001'],
    ['adset', 'status', 'PAUSED'],
    ['adset', 'campaign_id', changedId],
    ['adset', 'account_id', changedId],
    ['ad', 'status', 'PAUSED'],
    ['ad', 'effective_status', 'CAMPAIGN_PAUSED'],
    ['ad', 'campaign_id', changedId],
    ['ad', 'adset_id', changedId],
    ['ad', 'account_id', changedId],
    ['ad', 'name', 'Changed after insights'],
    ['ad', 'updated_time', '2026-09-20T16:00:01+0000']
  ] as const)('rejects a changed %s %s on the final read', async (type, field, value) => {
    const fixture = metaFixture()
    const nativeId = META_IDS[type]
    let changed = false
    const fetch = mockMetaFetch(fixture, (body, { url, visit }) => {
      if (url.pathname.endsWith(`/${nativeId}`) && visit === 2) {
        changed = true
        return { ...body, [field]: value }
      }
      return body
    })

    await expect(
      fetchLocalMetaEvidence([metaTarget('ad')], identity(), { fetch, now: () => META_NOW })
    ).rejects.toThrow(/native controls changed|native control or account scope is invalid/)
    expect(changed).toBe(true)
  })

  it.each([
    ['currency', 'CAD'],
    ['timezone_name', 'Etc/GMT+7'],
    ['id', `act_${changedId}`],
    ['account_id', changedId]
  ])('rejects changed account %s on the final read', async (field, value) => {
    let changed = false
    const fetch = mockMetaFetch(metaFixture(), (body, { url, visit }) => {
      if (url.pathname.endsWith(`/${META_ACCOUNT_ID}`) && visit === 2) {
        changed = true
        return { ...body, [field]: value }
      }
      return body
    })

    await expect(
      fetchLocalMetaEvidence([metaTarget()], identity(), { fetch, now: () => META_NOW })
    ).rejects.toThrow(
      /account, date, or authorized identity changed|account metadata does not match/
    )
    expect(changed).toBe(true)
  })

  it('rejects an account-local midnight rollover during the final read', async () => {
    const fixture = metaFixture()
    fixture.account.timezone_name = 'America/New_York'
    fixture.insight.date_start = '2026-09-20'
    fixture.insight.date_stop = '2026-09-20'
    let now = Date.parse('2026-09-21T03:59:59.000Z')
    let crossedMidnight = false
    const fetch = mockMetaFetch(fixture, (body, { url, visit }) => {
      if (url.pathname.endsWith(`/${META_ACCOUNT_ID}`) && visit === 2) {
        now += 1000
        crossedMidnight = true
      }
      return body
    })

    await expect(
      fetchLocalMetaEvidence([metaTarget()], identity(), { fetch, now: () => now })
    ).rejects.toThrow(
      'Local Meta account, date, or authorized identity changed during observation.'
    )
    expect(crossedMidnight).toBe(true)
  })

  it('rejects identity revocation while the first request is in flight', async () => {
    let current = true
    const fetch = mockMetaFetch(metaFixture(), (body) => {
      current = false
      return body
    })

    await expect(
      fetchLocalMetaEvidence(
        [metaTarget()],
        { token: 'fixture-only-token', isCurrent: () => current },
        { fetch, now: () => META_NOW }
      )
    ).rejects.toThrow('Local Meta evidence is unavailable.')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects identity revocation during final account readback', async () => {
    let current = true
    let finalRead = false
    const fetch = mockMetaFetch(metaFixture(), (body, { url, visit }) => {
      if (url.pathname.endsWith(`/${META_ACCOUNT_ID}`) && visit === 2) {
        current = false
        finalRead = true
      }
      return body
    })

    await expect(
      fetchLocalMetaEvidence(
        [metaTarget()],
        { token: 'fixture-only-token', isCurrent: () => current },
        { fetch, now: () => META_NOW }
      )
    ).rejects.toThrow('Local Meta evidence is unavailable.')
    expect(finalRead).toBe(true)
  })

  it('rejects a failed final authorization assertion after all control readbacks', async () => {
    const { fetch, assertCurrent, finalAssertion } = finalAuthorization(() => {
      throw new Error('Authorized identity changed.')
    })

    await expect(
      fetchLocalMetaEvidence(
        [metaTarget()],
        { ...identity(), assertCurrent },
        { fetch, now: () => META_NOW }
      )
    ).rejects.toThrow('Authorized identity changed.')
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(finalAssertion).toHaveBeenCalledOnce()
  })

  it('rechecks current identity after the final asynchronous authorization assertion', async () => {
    let current = true
    const { fetch, assertCurrent, finalAssertion } = finalAuthorization(() => {
      current = false
    })

    await expect(
      fetchLocalMetaEvidence(
        [metaTarget()],
        { token: 'fixture-only-token', isCurrent: () => current, assertCurrent },
        { fetch, now: () => META_NOW }
      )
    ).rejects.toThrow('Local Meta authorized identity or account date changed after observation.')
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(finalAssertion).toHaveBeenCalledOnce()
  })

  it('rechecks the account-local date after the final asynchronous authorization assertion', async () => {
    const fixture = metaFixture()
    fixture.account.timezone_name = 'America/New_York'
    let now = Date.parse('2026-09-21T03:59:59.000Z')
    const { fetch, assertCurrent, finalAssertion } = finalAuthorization(() => {
      now += 1000
    }, fixture)

    await expect(
      fetchLocalMetaEvidence(
        [metaTarget()],
        { ...identity(), assertCurrent },
        { fetch, now: () => now }
      )
    ).rejects.toThrow('Local Meta authorized identity or account date changed after observation.')
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(finalAssertion).toHaveBeenCalledOnce()
  })
})
