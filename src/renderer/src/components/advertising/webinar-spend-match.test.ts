import { describe, expect, it } from 'vitest'
import {
  salesAdsReport,
  webinarSummaryChecked
} from '../../../../shared/console-advertising-contract'
import { matchTodayWebinarSpend } from './webinar-spend-match'

const metrics = {
  registrations: 3,
  attended: 2,
  attended_live: 2,
  attended_replay: 0,
  attendance_rate: 2 / 3,
  avg_live_watch_seconds: 100,
  live_watch_samples: 2,
  live_watch_missing: 0,
  live_watch_zero: 0,
  watched_full: 1,
  watched_rate: 0.5,
  completion_known_attendees: 2,
  completion_unknown_attendees: 0
}

function report(over: Record<string, unknown> = {}) {
  return salesAdsReport.parse({
    company: 'omnirogue',
    account_id: 'act_2337',
    currency: 'USD',
    measured_at: '2026-09-13T16:00:00Z',
    date_start: '2026-09-13',
    date_stop: '2026-09-13',
    timezone: 'America/New_York',
    fetched_at: '2026-09-13T16:01:00Z',
    partial: false,
    sources: [{ name: 'meta', ok: true }],
    rows: [
      {
        id: 'row1',
        platform_id: '123',
        level: 'adset',
        name: 'Enterprise ad set',
        campaign_id: '456',
        segment: 'enterprise',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        spend: 100,
        link_clicks: 10,
        cpc_link: null,
        checkouts: 0,
        add_to_carts: 0,
        impressions: 1000,
        reach: 800,
        revenue: 0,
        leads: 0,
        registrations: 0,
        purchases: 0
      }
    ],
    ...over
  })
}

function summary(over: Record<string, unknown> = {}) {
  return webinarSummaryChecked.parse({
    company: 'omnirogue',
    provider: 'everwebinar',
    window: 'today',
    cohort: {
      basis: 'signup_date',
      start: '2026-09-13T00:00:00-04:00',
      end: '2026-09-14T00:00:00-04:00',
      time_zone: 'America/New_York',
      includes_today: true
    },
    as_of: '2026-09-13T16:05:00Z',
    metrics,
    by_adset: [{ id: '123', name: 'Webinar ad set', ...metrics }],
    by_ad: [],
    attribution: {
      adset_mapped_registrations: 3,
      ad_mapped_registrations: 0,
      unattributed_adset_registrations: 0,
      unattributed_ad_registrations: 3,
      unresolved_template_registrations: 0
    },
    ...over
  })
}

describe('today-only WebinarJam spend matching', () => {
  it('derives each cost only from the same Enterprise ad-set ID and signup cohort', () => {
    const match = matchTodayWebinarSpend(report(), summary())
    expect(match.withheld).toBeNull()
    expect(match.rows).toHaveLength(1)
    expect(match.rows[0]).toMatchObject({
      id: '123',
      spend: 100,
      registrations: 3,
      attended: 2,
      full: 1,
      costPerAttendee: 50,
      costPerFull: 100
    })
    expect(match.rows[0].costPerRegistration).toBeCloseTo(100 / 3)
    expect(match.unmatchedRegistrations).toBe(0)
  })

  it('withholds a mismatched timezone, date, observation or incomplete Meta source', () => {
    expect(matchTodayWebinarSpend(report({ timezone: 'America/Chicago' }), summary()).rows).toEqual(
      []
    )
    expect(matchTodayWebinarSpend(report({ date_start: '2026-09-12' }), summary()).rows).toEqual([])
    expect(
      matchTodayWebinarSpend(report({ measured_at: '2026-09-13T15:00:00Z' }), summary()).rows
    ).toEqual([])
    expect(matchTodayWebinarSpend(report({ partial: true }), summary()).rows).toEqual([])
  })

  it('does not join the seven complete WebinarJam days to a Meta range that includes today', () => {
    expect(matchTodayWebinarSpend(report(), summary({ window: 'd7' })).rows).toEqual([])
  })

  it('leaves unmapped signups outside every matched cost', () => {
    const extra = summary({
      metrics: { ...metrics, registrations: 5, attendance_rate: 2 / 5 },
      attribution: {
        adset_mapped_registrations: 3,
        ad_mapped_registrations: 0,
        unattributed_adset_registrations: 2,
        unattributed_ad_registrations: 5,
        unresolved_template_registrations: 0
      }
    })
    expect(matchTodayWebinarSpend(report(), extra).unmatchedRegistrations).toBe(2)
  })
})
