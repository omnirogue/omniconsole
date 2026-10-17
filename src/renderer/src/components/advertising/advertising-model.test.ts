import { describe, expect, it } from 'vitest'
import {
  campaignGroups,
  combineTotals,
  comparableWindows,
  routineContext,
  segmentTotals,
  stripeCashWindow
} from './advertising-model'
import {
  salesAdRow,
  salesAdsReport,
  type SalesAdRow,
  type SalesAdsReport
} from '../../../../shared/console-advertising-contract'
import type { ScorecardDocument } from '../../../../shared/console-scorecard-contract'

function row(over: Record<string, unknown> = {}): SalesAdRow {
  return salesAdRow.parse({
    id: 'r1',
    platform_id: 'p1',
    level: 'campaign',
    name: 'Campaign',
    campaign_id: 'p1',
    campaign_name: 'Campaign',
    parent_id: null,
    segment: 'dtc',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    spend: 100,
    link_clicks: 50,
    cpc_link: null,
    checkouts: 5,
    add_to_carts: 10,
    impressions: 1000,
    reach: 800,
    revenue: 300,
    leads: 4,
    lead_event: 'Lead',
    registrations: 20,
    purchases: 2,
    can_pause: true,
    pause_blocker: null,
    measured_at: '2026-09-12T12:00:00Z',
    ...over
  })
}
function report(over: Record<string, unknown> = {}): SalesAdsReport {
  return salesAdsReport.parse({
    company: 'omnirogue',
    account_id: 'act_2337',
    currency: 'USD',
    measured_at: '2026-09-12T12:00:00Z',
    date_start: '2026-09-12',
    date_stop: '2026-09-12',
    timezone: 'America/New_York',
    fetched_at: '2026-09-12T12:01:00Z',
    partial: false,
    rows: [row()],
    sources: [{ name: 'meta:insights', ok: true, note: null, error: null, fetched_at: null }],
    can_pause: true,
    ...over
  })
}

describe('advertising totals', () => {
  it('sums one level of measured campaigns and derives each cost from the shown counts', () => {
    const totals = segmentTotals(report(), 'dtc')
    expect(totals.spend).toBe(100)
    expect(totals.revenue).toBe(300)
    expect(totals.profit).toBe(200)
    expect(totals.roas).toBe(3)
    expect(totals.costPerClick).toBe(2)
    expect(totals.costPerRegistration).toBe(5)
    expect(totals.costPerPurchase).toBe(50)
    expect(totals.costPerLead).toBe(25)
    expect(totals.partial).toBe(false)
    expect(totals.unmeasured).toBe(0)
  })

  it('counts a campaign with no insight as unmeasured rather than as a zero-spend day', () => {
    const totals = segmentTotals(
      report({
        rows: [row(), row({ id: 'r2', platform_id: 'p2', spend: null, revenue: null })]
      }),
      'dtc'
    )
    expect(totals.spend).toBe(100)
    expect(totals.unmeasured).toBe(1)
  })

  it('withholds profit and ROAS on a partial report but still shows what was measured', () => {
    const totals = segmentTotals(report({ partial: true }), 'dtc')
    expect(totals.spend).toBe(100)
    expect(totals.revenue).toBe(300)
    expect(totals.profit).toBeNull()
    expect(totals.roas).toBeNull()
    expect(totals.partial).toBe(true)
  })

  it('treats a failed source as partial', () => {
    const totals = segmentTotals(
      report({
        sources: [
          { name: 'meta:insights', ok: false, note: null, error: 'rate limited', fetched_at: null }
        ]
      }),
      'dtc'
    )
    expect(totals.partial).toBe(true)
    expect(totals.profit).toBeNull()
  })

  it('counts each provider object once and flags the duplicate as partial', () => {
    const totals = segmentTotals(report({ rows: [row(), row({ id: 'r2' })] }), 'dtc')
    expect(totals.spend).toBe(100)
    expect(totals.partial).toBe(true)
  })

  it('makes a total unknown when one row in scope did not report the field', () => {
    const totals = segmentTotals(
      report({ rows: [row(), row({ id: 'r2', platform_id: 'p2', purchases: null })] }),
      'dtc'
    )
    expect(totals.spend).toBe(200)
    expect(totals.purchases).toBeNull()
    expect(totals.costPerPurchase).toBeNull()
  })

  it('refuses to show a cost per lead when the account maps no Lead event', () => {
    const totals = segmentTotals(report({ rows: [row({ lead_event: null })] }), 'dtc')
    expect(totals.leads).toBeNull()
    expect(totals.costPerLead).toBeNull()
    expect(totals.leadEvent).toBeNull()
  })

  it('knows nothing about an account that does not report in dollars', () => {
    expect(segmentTotals(report({ currency: 'EUR' }), 'dtc').spend).toBeNull()
  })

  it('keeps a combined total unknown when one part is unknown', () => {
    const known = segmentTotals(report(), 'dtc')
    const unknown = segmentTotals(null)
    const combined = combineTotals([known, unknown])
    expect(combined.spend).toBeNull()
    expect(combined.profit).toBeNull()
  })

  it('adds two known parts and re-derives the blended costs', () => {
    const combined = combineTotals([segmentTotals(report(), 'dtc'), segmentTotals(report(), 'dtc')])
    expect(combined.spend).toBe(200)
    expect(combined.revenue).toBe(600)
    expect(combined.roas).toBe(3)
    expect(combined.costPerPurchase).toBe(50)
  })

  it('retains unclassified campaign spend in account totals when Enterprise has no measured rows', () => {
    const omni = report({
      rows: [
        row(),
        row({
          id: 'unknown',
          platform_id: 'unknown',
          segment: 'other',
          spend: 37.96,
          revenue: 0
        })
      ]
    })
    const sway = report({ company: 'betacorp', rows: [row({ spend: 5, revenue: 0 })] })
    expect(segmentTotals(omni, 'enterprise').spend).toBeNull()
    expect(segmentTotals(omni).spend).toBe(137.96)
    expect(combineTotals([segmentTotals(omni), segmentTotals(sway)])).toMatchObject({
      spend: 142.96,
      revenue: 300
    })
  })

  it('only allows two accounts to be added when dates and timezones match', () => {
    expect(comparableWindows(report(), report())).toBe(true)
    expect(comparableWindows(report(), report({ date_start: '2026-09-11' }))).toBe(false)
    expect(comparableWindows(report(), report({ timezone: 'America/Los_Angeles' }))).toBe(false)
    expect(comparableWindows(report(), null)).toBe(false)
  })
})

describe('campaign grouping', () => {
  const campaign = row({ platform_id: 'c1', campaign_id: 'c1', name: 'Live campaign' })
  const pausedCampaign = row({
    id: 'r9',
    platform_id: 'c2',
    campaign_id: 'c2',
    name: 'Paused campaign',
    status: 'PAUSED',
    effective_status: 'PAUSED'
  })
  const liveAdSet = row({
    id: 'a1',
    platform_id: 'as1',
    level: 'adset',
    campaign_id: 'c1',
    name: 'Live ad set'
  })
  const pausedAdSet = row({
    id: 'a2',
    platform_id: 'as2',
    level: 'adset',
    campaign_id: 'c1',
    name: 'Paused ad set',
    status: 'PAUSED',
    effective_status: 'ADSET_PAUSED'
  })

  it('shows live ad sets under an enabled campaign and counts active out of total', () => {
    const groups = campaignGroups([campaign], [liveAdSet, pausedAdSet], { liveOnly: true })
    expect(groups).toHaveLength(1)
    expect(groups[0].adSets.map((entry) => entry.row.name)).toEqual(['Live ad set'])
    expect(groups[0].activeAdSets).toBe(1)
    expect(groups[0].totalAdSets).toBe(2)
  })

  it('hides a paused campaign from the live detail without touching the totals above', () => {
    const live = campaignGroups([campaign, pausedCampaign], [liveAdSet], { liveOnly: true })
    expect(live.map((group) => group.campaignId)).toEqual(['c1'])
    const all = campaignGroups([campaign, pausedCampaign], [liveAdSet], { liveOnly: false })
    expect(all).toHaveLength(2)
  })

  it('never merges two ad sets with no campaign id into one campaign', () => {
    const orphanA = row({ id: 'o1', platform_id: 'x1', level: 'adset', campaign_id: null })
    const orphanB = row({ id: 'o2', platform_id: 'x2', level: 'adset', campaign_id: null })
    const groups = campaignGroups([], [orphanA, orphanB], { liveOnly: false })
    expect(groups).toHaveLength(2)
  })

  it('counts an ad set whose status the provider did not report', () => {
    const unknown = row({
      id: 'u1',
      platform_id: 'as3',
      level: 'adset',
      campaign_id: 'c1',
      status: null,
      effective_status: null
    })
    const groups = campaignGroups([campaign], [unknown], { liveOnly: false })
    expect(groups[0].unknownAdSets).toBe(1)
    expect(groups[0].activeAdSets).toBe(0)
  })

  it('does not call an ad set live when effective delivery is unknown or under review', () => {
    for (const effective_status of [null, 'PENDING_REVIEW']) {
      const uncertain = row({
        id: `uncertain-${effective_status}`,
        platform_id: `as-${effective_status}`,
        level: 'adset',
        campaign_id: 'c1',
        status: 'ACTIVE',
        effective_status
      })
      expect(campaignGroups([campaign], [uncertain], { liveOnly: true })).toEqual([])
      expect(campaignGroups([campaign], [uncertain], { liveOnly: false })[0].activeAdSets).toBe(0)
    }
  })

  it('does not claim an orphan ad set is live without its enabled parent campaign', () => {
    expect(campaignGroups([], [liveAdSet], { liveOnly: true })).toEqual([])
    expect(campaignGroups([], [liveAdSet], { liveOnly: false })).toHaveLength(1)
  })
})

describe('Stripe cash window', () => {
  const scorecard = (over: Partial<ScorecardDocument> = {}): ScorecardDocument =>
    ({
      generated_at: '2026-09-12T16:00:00Z',
      timezone: 'America/New_York',
      today: '2026-09-12',
      companies: [
        {
          slug: 'omnirogue',
          today: { date: '2026-09-12', reported: ['revenue'], revenue: 500 },
          days: [{ date: '2026-09-11', reported: ['revenue'], revenue: 400 }]
        }
      ],
      ...over
    }) as ScorecardDocument

  it('adds only days the collector vouched for', () => {
    expect(stripeCashWindow(scorecard(), 'omnirogue', 1)).toBe(500)
    expect(stripeCashWindow(scorecard(), 'omnirogue', 2)).toBe(900)
  })

  it('returns nothing when a day in the window is missing', () => {
    expect(stripeCashWindow(scorecard(), 'omnirogue', 3)).toBeNull()
  })

  it('returns nothing when Stripe truncated a day, rather than a sum with a hole in it', () => {
    const document = scorecard()
    document.companies[0].today = {
      date: '2026-09-12',
      reported: ['revenue'],
      revenue: 500,
      stripe_truncated: true
    }
    expect(stripeCashWindow(document, 'omnirogue', 1)).toBeNull()
  })

  it('returns nothing when revenue was not among the reported fields', () => {
    const document = scorecard()
    document.companies[0].today = { date: '2026-09-12', reported: ['ad_spend'], revenue: 0 }
    expect(stripeCashWindow(document, 'omnirogue', 1)).toBeNull()
  })

  it('knows nothing about a company the scorecard does not carry', () => {
    expect(stripeCashWindow(scorecard(), 'betacorp', 1)).toBeNull()
    expect(stripeCashWindow(null, 'omnirogue', 1)).toBeNull()
  })
})

describe('routine context', () => {
  it('keeps the routine account separate from the provider figures', () => {
    const context = routineContext({
      operation: {
        mode: 'auto',
        status: 'armed',
        account_state: 'ARMED',
        interval_minutes: 15,
        last_evaluated_at: '2026-09-12T15:40:00Z',
        last_successful_evaluation_at: '2026-09-12T15:30:00Z',
        next_due_at: '2026-09-12T15:55:00Z',
        insights_age_seconds: 1800,
        insights_observed_at: '2026-09-12T15:00:00Z',
        spend_observed_at: null,
        fact_coverage_complete: false,
        coverage: {
          evaluated: 12,
          active: 4,
          paused: 8,
          complete: false,
          campaigns: 4,
          adsets: 12,
          ads: 20
        },
        errors: ['one source lagged']
      },
      money: { spend_today: 120, active_daily_budget: 300, currency: 'USD' },
      policy: { probability_model_calibrated: false }
    } as never)
    expect(context?.lastEvaluatedAt).toBe('2026-09-12T15:30:00Z')
    expect(context?.insightsAgeSeconds).toBe(1800)
    expect(context?.coverageComplete).toBe(false)
    // The allowance and the money that moved stay two fields.
    expect(context?.activeDailyBudget).toBe(300)
    expect(context?.spendToday).toBe(120)
    expect(context?.probabilityModelCalibrated).toBe(false)
  })

  it('is absent when no coordinator answered', () => {
    expect(routineContext(null)).toBeNull()
  })
})
