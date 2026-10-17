import {
  isActiveAdObject,
  isPausedAdObject,
  type AdvertisingDecision,
  type SalesAdRow,
  type SalesAdsReport,
  type SalesCompany,
  type SalesSegment
} from '../../../../shared/console-advertising-contract'
import type { ScorecardDocument } from '../../../../shared/console-scorecard-contract'

import { round } from './advertising-totals'

export * from './advertising-totals'

/**
 * The Advertising view's projections: which books Sal reads, how campaigns and
 * their ad sets nest, what Stripe collected, how fresh a report is, and what the
 * routine says about itself. The arithmetic lives in `advertising-totals`, which
 * this file re-exports so a caller has one import.
 *
 * The separation this file exists to hold: actual spend, active daily budget,
 * Meta-attributed revenue and Stripe cash are four facts, and none is ever added
 * to another.
 */

export type AdSegmentId = 'enterprise' | 'dtc' | 'betacorp'

export type AdSegment = {
  id: AdSegmentId
  company: SalesCompany
  name: string
  kind: string
  /** The row segment this card sums; BetaCorp's account is not segmented. */
  filter: SalesSegment | undefined
}

/** The three books Sal reads separately. OmniRogue's one Meta account carries two. */
export const AD_SEGMENTS: readonly AdSegment[] = [
  {
    id: 'enterprise',
    company: 'omnirogue',
    name: 'OmniRogue Enterprise',
    kind: 'Enterprise',
    filter: 'enterprise'
  },
  {
    id: 'dtc',
    company: 'omnirogue',
    name: 'OmniRogue DTC',
    kind: 'Direct to consumer',
    filter: 'dtc'
  },
  {
    id: 'betacorp',
    company: 'betacorp',
    name: 'BetaCorp',
    kind: 'Direct to consumer',
    filter: undefined
  }
]
export type AdSetRow = {
  row: SalesAdRow
  active: boolean
  paused: boolean
}

export type CampaignGroup = {
  campaignId: string
  name: string
  campaign: SalesAdRow | null
  /** Live ad sets under this campaign, which is what Sal reads in the detail. */
  adSets: AdSetRow[]
  activeAdSets: number
  totalAdSets: number
  /** Ad sets whose own or effective status the provider did not report. */
  unknownAdSets: number
}

/**
 * Campaigns with their ad sets beneath, grouped by stable parent identity.
 * A missing campaign id never merges two unrelated objects into one campaign.
 */
export function campaignGroups(
  campaigns: readonly SalesAdRow[],
  adSets: readonly SalesAdRow[],
  options: { liveOnly: boolean }
): CampaignGroup[] {
  const byId = new Map<string, SalesAdRow>()
  for (const campaign of campaigns) {
    byId.set(campaign.platform_id, campaign)
  }
  const grouped = new Map<string, SalesAdRow[]>()
  for (const row of adSets) {
    const key = row.campaign_id ?? `unknown:${row.platform_id}`
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  const keys = new Set<string>([...byId.keys(), ...grouped.keys()])
  const groups: CampaignGroup[] = []
  for (const key of keys) {
    const campaign = byId.get(key) ?? null
    // Why: Sal reads live ad sets under enabled campaigns. A paused campaign's
    // spend still counts in the account total above; its ad sets are not "live".
    if (options.liveOnly && (campaign === null || !isActiveAdObject(campaign))) {
      continue
    }
    const inventory = [
      ...new Map((grouped.get(key) ?? []).map((row) => [row.platform_id, row])).values()
    ]
    const rows: AdSetRow[] = inventory.map((row) => ({
      row,
      active: isActiveAdObject(row),
      paused: isPausedAdObject(row)
    }))
    const shown = options.liveOnly ? rows.filter((entry) => entry.active) : rows
    if (options.liveOnly && shown.length === 0) {
      continue
    }
    groups.push({
      campaignId: key,
      name:
        campaign?.name ??
        inventory[0]?.campaign_name ??
        (key.startsWith('unknown:') ? 'Campaign unavailable' : key),
      campaign,
      adSets: shown,
      activeAdSets: rows.filter((entry) => entry.active).length,
      totalAdSets: rows.length,
      unknownAdSets: rows.filter((entry) => !entry.row.status || !entry.row.effective_status).length
    })
  }
  return groups.sort((left, right) => {
    const spend = (right.campaign?.spend ?? 0) - (left.campaign?.spend ?? 0)
    return spend !== 0 ? spend : left.name.localeCompare(right.name)
  })
}

/**
 * Stripe cash collected over the window, or null. This is money in the bank for
 * every channel including rebills, so it is shown beside Meta revenue and never
 * added to it. A truncated or unreported day makes the whole window unknown
 * rather than a sum with a hole in it.
 */
export function stripeCashWindow(
  scorecard: ScorecardDocument | null,
  company: string,
  days: number
): number | null {
  const account = scorecard?.companies.find((row) => row.slug === company)
  if (!scorecard || !account) {
    return null
  }
  const end = Date.parse(`${scorecard.today}T00:00:00Z`)
  if (!Number.isFinite(end)) {
    return null
  }
  const wanted = Array.from({ length: days }, (_, index) =>
    new Date(end - index * 86_400_000).toISOString().slice(0, 10)
  )
  const values = wanted.map((date) => {
    const candidates =
      date === scorecard.today
        ? account.today
          ? [account.today]
          : []
        : account.days.filter((row) => row.date === date)
    if (candidates.length !== 1) {
      return null
    }
    const day = candidates[0]
    if (day.stripe_truncated === true) {
      return null
    }
    if (day.reported !== undefined && !day.reported.includes('revenue')) {
      return null
    }
    return typeof day.revenue === 'number' && Number.isFinite(day.revenue) ? day.revenue : null
  })
  return values.every((value) => value !== null)
    ? round(values.reduce<number>((total, value) => total + (value ?? 0), 0))
    : null
}

export type FreshnessNote = {
  /** The provider observation behind the figures, not the time they were relayed. */
  observedAt: string | null
  /** When this client received the answer. */
  reportedAt: string | null
  window: { start: string; stop: string } | null
  timezone: string | null
  partial: boolean
  failedSources: string[]
}

export function freshnessOf(report: SalesAdsReport | null): FreshnessNote | null {
  if (!report) {
    return null
  }
  return {
    observedAt: report.measured_at,
    reportedAt: report.fetched_at,
    window: { start: report.date_start, stop: report.date_stop },
    timezone: report.timezone,
    partial: report.partial,
    failedSources: report.sources.filter((source) => !source.ok).map((source) => source.name)
  }
}

/** True when both accounts covered the same dates, so their totals may be added. */
export function comparableWindows(
  left: SalesAdsReport | null,
  right: SalesAdsReport | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.date_start === right.date_start &&
    left.date_stop === right.date_stop &&
    left.timezone === right.timezone
  )
}

export type RoutineContext = {
  mode: AdvertisingDecision['operation']['mode']
  status: string
  accountState: string | null
  lastEvaluatedAt: string | null
  nextDueAt: string | null
  /** Age of the provider observation, in seconds, when the coordinator reported one. */
  insightsAgeSeconds: number | null
  insightsObservedAt: string | null
  coverageComplete: boolean | null
  evaluated: number | null
  activeObjects: number | null
  errors: string[]
  activeDailyBudget: number | null
  spendToday: number | null
  spendingLimitRemaining: number | null
  currency: string | null
  probabilityModelCalibrated: boolean | null
}

/**
 * The routine's own account of itself. Its last run is not a live provider read,
 * so the view shows when it last evaluated and how old its observation is —
 * separately from the numbers it produced.
 */
export function routineContext(decision: AdvertisingDecision | null): RoutineContext | null {
  if (!decision) {
    return null
  }
  return {
    mode: decision.operation.mode,
    status: decision.operation.status,
    accountState: decision.operation.account_state ?? null,
    lastEvaluatedAt:
      decision.operation.last_successful_evaluation_at ?? decision.operation.last_evaluated_at,
    nextDueAt: decision.operation.next_due_at,
    insightsAgeSeconds: decision.operation.insights_age_seconds ?? null,
    insightsObservedAt: decision.operation.insights_observed_at,
    coverageComplete: decision.operation.fact_coverage_complete ?? null,
    evaluated: decision.operation.coverage.evaluated ?? null,
    activeObjects: decision.operation.coverage.active ?? null,
    errors: decision.operation.errors,
    activeDailyBudget: decision.money.active_daily_budget ?? null,
    spendToday: decision.money.spend_today ?? null,
    spendingLimitRemaining: decision.money.spending_limit_remaining ?? null,
    currency: decision.money.currency,
    probabilityModelCalibrated: decision.policy.probability_model_calibrated ?? null
  }
}
