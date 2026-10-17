import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleAdvertisingClient } from '../backoffice/console-advertising-client'
import { advertisingDecision } from '../../shared/console-ad-decision-contract'
import { advertisingRoutinePolicy, type AdvertisingTarget } from '../../shared/typesafe-advertising'
import {
  fetchAdvertisingEvidence,
  readAdvertisingCandidates
} from './typesafe-advertising-evidence'
import {
  advertisingTestEvidence as evidence,
  advertisingTestPolicy as policy
} from './typesafe-advertising-fixtures'

vi.mock('../backoffice/console-advertising-client', () => ({
  consoleAdvertisingClient: { decision: vi.fn() }
}))
const content = (value: unknown) =>
  `Report prose is not evidence.\n\`\`\`omni-advertising-candidates\n${JSON.stringify(value)}\n\`\`\``
const source = () => ({
  schema_version: 1,
  company: 'OmniRogue',
  account_id: policy.accountId,
  operation: {
    mode: 'recommend',
    status: 'active',
    coverage: { complete: true },
    fact_coverage_complete: true,
    insights_observed_at: evidence.measuredAt
  },
  windows: {
    timezone: 'UTC',
    today: { start: evidence.dateStart, end: evidence.dateStop },
    seven: {}
  },
  money: { currency: 'USD' },
  decisions: [],
  policy: {},
  evidence_revision: 'native-observation-1',
  pagination: {
    section: 'statistics',
    offset: 0,
    limit: 20,
    total: 1,
    returned: 1,
    has_more: false,
    campaign_id: '123458'
  },
  statistics: {
    native_population_complete: true,
    display_only: false,
    complete: true,
    observed_at: evidence.measuredAt,
    account: {},
    limitations: [],
    event_mappings: { lead: 'lead' },
    hierarchy: [
      {
        object_id: '123457',
        level: 'adset',
        name: 'Observed ad set',
        campaign_id: '123458',
        adset_id: '123457',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        owning_daily_budget: 50,
        budget_owner_id: '123457',
        metrics: {
          today: {
            spend: 42,
            attributed_revenue: 0,
            purchases: 0,
            registrations: 0,
            leads: 0,
            checkouts: 0,
            link_clicks: 5,
            impressions: 1000
          }
        }
      }
    ]
  }
})
function answer(raw = source()) {
  vi.mocked(consoleAdvertisingClient.decision).mockResolvedValue({
    ok: true,
    data: advertisingDecision.parse(raw)
  })
}
beforeEach(() => vi.mocked(consoleAdvertisingClient.decision).mockReset())
describe('advertising source evidence', () => {
  it('accepts selectors before a required final legacy action block without treating actions as evidence', () => {
    const report = `${content([evidence.target])}\n\n\`\`\`omni-actions\n${JSON.stringify([{ action: 'PAUSE', inventedSpend: 99_999 }])}\n\`\`\``
    expect(readAdvertisingCandidates(report)).toEqual([evidence.target])
    expect(report.endsWith('```')).toBe(true)
  })
  it('defaults to ad sets and ads and rejects unsupported policy object types', () => {
    const input = { company: policy.company, accountId: policy.accountId }
    expect(advertisingRoutinePolicy.parse(input).allowedObjectTypes).toEqual(['adset', 'ad'])
    expect(advertisingRoutinePolicy.safeParse({ ...input, allowedObjectTypes: [] }).success).toBe(
      false
    )
    expect(
      advertisingRoutinePolicy.safeParse({ ...input, allowedObjectTypes: ['account'] }).success
    ).toBe(false)
  })

  it('requires explicit campaign permission and rejects out-of-scope targets before source reads', async () => {
    const campaign: AdvertisingTarget = {
      ...evidence.target,
      objectType: 'campaign',
      nativeId: evidence.target.campaignId,
      adsetId: null
    }
    expect(() => readAdvertisingCandidates(content([campaign]))).toThrow(
      'configured advertising object types'
    )
    expect(() =>
      readAdvertisingCandidates(content([evidence.target]), { allowedObjectTypes: ['ad'] })
    ).toThrow('configured advertising object types')
    expect(
      readAdvertisingCandidates(content([campaign]), { allowedObjectTypes: ['campaign'] })
    ).toEqual([campaign])
    await expect(fetchAdvertisingEvidence([campaign], policy)).rejects.toThrow(
      'configured advertising object types'
    )
    expect(consoleAdvertisingClient.decision).not.toHaveBeenCalled()
  })

  it('requires typed complete identities and refuses prose, duplicate IDs and invented fields', () => {
    expect(readAdvertisingCandidates(content([evidence.target]))).toEqual([evidence.target])
    expect(() => readAdvertisingCandidates('Pause 123457 because revenue is zero.')).toThrow()
    expect(() => readAdvertisingCandidates(content([{ ...evidence.target, spend: 0 }]))).toThrow()
    expect(() => readAdvertisingCandidates(content([evidence.target, evidence.target]))).toThrow()
    expect(() =>
      readAdvertisingCandidates(content([{ ...evidence.target, adsetId: '999999' }]))
    ).toThrow()
  })
  it('loads native metrics from the exact signed campaign scope', async () => {
    answer()
    const result = await fetchAdvertisingEvidence(
      [evidence.target],
      policy,
      Date.parse(evidence.fetchedAt)
    )
    expect(result).toEqual([{ ...evidence, fetchedAt: new Date(evidence.fetchedAt).toISOString() }])
    expect(consoleAdvertisingClient.decision).toHaveBeenCalledWith({
      instanceId: 'adops-omnirogue',
      section: 'statistics',
      campaignId: '123458',
      offset: 0,
      limit: 20
    })
  })
  it('rejects cross-account and display-only cached statistics', async () => {
    answer({ ...source(), account_id: 'act_999999' })
    await expect(fetchAdvertisingEvidence([evidence.target], policy)).rejects.toThrow(
      'complete native'
    )
    const cached = source()
    cached.statistics.display_only = true
    cached.statistics.native_population_complete = false
    answer(cached)
    await expect(fetchAdvertisingEvidence([evidence.target], policy)).rejects.toThrow(
      'complete native'
    )
  })
  it('refuses stale observations, incomplete fact coverage and a changed campaign parent', async () => {
    answer()
    await expect(
      fetchAdvertisingEvidence([evidence.target], policy, Date.parse(evidence.fetchedAt) + 301_000)
    ).rejects.toThrow('stale')
    const partial = source()
    partial.operation.fact_coverage_complete = false
    answer(partial)
    await expect(fetchAdvertisingEvidence([evidence.target], policy)).rejects.toThrow(
      'complete native'
    )
    const moved = source()
    moved.statistics.hierarchy[0].campaign_id = '999999'
    answer(moved)
    await expect(fetchAdvertisingEvidence([evidence.target], policy)).rejects.toThrow('hierarchy')
  })
  it('never substitutes fresh retrieval time for missing observation time', async () => {
    const missing = { ...source(), statistics: { ...source().statistics, observed_at: null } }
    vi.mocked(consoleAdvertisingClient.decision).mockResolvedValue({
      ok: true,
      data: advertisingDecision.parse(missing)
    })
    await expect(
      fetchAdvertisingEvidence([evidence.target], policy, Date.parse(evidence.fetchedAt))
    ).rejects.toThrow('complete native')
  })
})
