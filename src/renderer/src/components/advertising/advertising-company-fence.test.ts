import { describe, expect, it } from 'vitest'
import { campaignGroups } from './advertising-model'
import {
  normalizeCompany,
  salesAdRow,
  salesAdsReport,
  type SalesAdRow,
  type SalesAdsReport
} from '../../../../shared/console-advertising-contract'

/**
 * The fence that keeps one account's numbers out of another account's table.
 *
 * The page reads the campaign level for both accounts at once and the ad-set level for
 * the SELECTED account only. Those are separate async reads, and the hook that clears a
 * stale answer does so in an effect — which runs after the render that follows picking a
 * different segment. So for exactly one render the new company's campaigns would be
 * grouped with the previous company's ad sets, and another account's spend would appear
 * under this account's heading.
 *
 * The page therefore compares the answer's own company to the selected one before using
 * it. These tests hold that rule at the two places it has to be true.
 */

function row(over: Record<string, unknown> = {}): SalesAdRow {
  return salesAdRow.parse({
    id: 'r',
    platform_id: 'p',
    level: 'campaign',
    name: 'Campaign',
    campaign_id: 'p',
    campaign_name: 'Campaign',
    parent_id: null,
    segment: 'dtc',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    spend: 100,
    link_clicks: 10,
    cpc_link: null,
    checkouts: 1,
    add_to_carts: 2,
    impressions: 100,
    reach: 90,
    revenue: 200,
    leads: 1,
    lead_event: 'Lead',
    registrations: 5,
    purchases: 1,
    can_pause: true,
    pause_blocker: null,
    measured_at: '2026-09-12T12:00:00Z',
    ...over
  })
}
function report(company: 'omnirogue' | 'betacorp', rows: SalesAdRow[]): SalesAdsReport {
  return salesAdsReport.parse({
    company,
    account_id: company === 'omnirogue' ? 'act_2337' : 'act_2209',
    currency: 'USD',
    measured_at: '2026-09-12T12:00:00Z',
    date_start: '2026-09-12',
    date_stop: '2026-09-12',
    timezone: 'America/New_York',
    fetched_at: '2026-09-12T12:01:00Z',
    partial: false,
    rows,
    sources: [],
    can_pause: false
  })
}

/** Exactly what the page does: use an answer only when it is this company's. */
function fenced(
  answer: SalesAdsReport | null,
  company: 'omnirogue' | 'betacorp'
): SalesAdsReport | null {
  return answer?.company === company ? answer : null
}

describe('an answer paints only for the company it belongs to', () => {
  const betacorpCampaign = row({
    platform_id: 'sb-c1',
    campaign_id: 'sb-c1',
    name: 'BetaCorp campaign'
  })
  const omnirogueAdSet = row({
    id: 'or-a1',
    platform_id: 'or-as1',
    level: 'adset',
    campaign_id: 'sb-c1',
    name: 'OmniRogue ad set',
    spend: 999
  })

  it('keeps the previous account’s ad sets out of the new account’s table', () => {
    const stale = report('omnirogue', [omnirogueAdSet])
    // Unfenced, the ad set joins the BetaCorp campaign because the ids happen to align.
    const unfenced = campaignGroups([betacorpCampaign], stale.rows, { liveOnly: false })
    expect(unfenced[0].adSets.map((entry) => entry.row.name)).toEqual(['OmniRogue ad set'])
    // Fenced, the answer is not this company's, so the table shows no ad sets at all.
    const guarded = campaignGroups([betacorpCampaign], fenced(stale, 'betacorp')?.rows ?? [], {
      liveOnly: false
    })
    expect(guarded[0].adSets).toEqual([])
    expect(guarded[0].totalAdSets).toBe(0)
  })

  it('uses the answer once it is the right company’s', () => {
    const fresh = report('betacorp', [
      row({
        id: 'sb-a1',
        platform_id: 'sb-as1',
        level: 'adset',
        campaign_id: 'sb-c1',
        name: 'BetaCorp ad set'
      })
    ])
    const groups = campaignGroups([betacorpCampaign], fenced(fresh, 'betacorp')?.rows ?? [], {
      liveOnly: false
    })
    expect(groups[0].adSets.map((entry) => entry.row.name)).toEqual(['BetaCorp ad set'])
  })

  it('shows nothing rather than the wrong thing while the new read is in flight', () => {
    expect(fenced(null, 'betacorp')).toBeNull()
    expect(fenced(report('omnirogue', []), 'betacorp')).toBeNull()
  })
})

describe('a company fence does not depend on spelling', () => {
  it('matches the coordinator’s own spelling of a company', () => {
    // The coordinator answers "OmniRogue"; the segment says "omnirogue". A raw string
    // comparison would reject its own account's answer and show no routine at all.
    expect(normalizeCompany('OmniRogue')).toBe(normalizeCompany('omnirogue'))
    expect(normalizeCompany('omni-rogue')).toBe(normalizeCompany('omnirogue'))
    expect(normalizeCompany('Omni Rogue')).toBe(normalizeCompany('omnirogue'))
  })

  it('still separates two different companies', () => {
    expect(normalizeCompany('BetaCorp')).not.toBe(normalizeCompany('omnirogue'))
  })
})
