import { z } from 'zod'
import { consoleAdvertisingClient } from '../backoffice/console-advertising-client'
import { normalizeCompany } from '../../shared/console-adops-contract'
import { unitCost } from '../../shared/console-advertising-leaves'
import {
  advertisingEvidence,
  type AdvertisingEvidence,
  type AdvertisingRoutinePolicy,
  type AdvertisingTarget
} from '../../shared/typesafe-advertising'
import type { AdvertisingDecision } from '../../shared/console-ad-decision-contract'

const id = z.string().regex(/^[0-9]{5,30}$/)
const metric = z
  .number()
  .finite()
  .nonnegative()
  .nullable()
  .optional()
  .transform((value) => value ?? null)
const nativeMetrics = z.object({
  spend: metric,
  attributed_revenue: metric,
  purchases: metric,
  registrations: metric,
  leads: metric,
  checkouts: metric,
  link_clicks: metric,
  impressions: metric
})
const nativeRow = z.object({
  object_id: id,
  level: z.enum(['campaign', 'adset', 'ad']),
  campaign_id: id.nullable(),
  adset_id: id.nullable(),
  name: z.string().max(1000),
  status: z.enum(['ACTIVE', 'PAUSED']),
  effective_status: z.string().min(1),
  owning_daily_budget: metric,
  budget_owner_id: id.nullable(),
  metrics: z.object({ today: nativeMetrics })
})
const nativeStatistics = z.object({
  native_population_complete: z.literal(true),
  display_only: z.literal(false).optional(),
  snapshot_atomic: z.literal(true).optional(),
  observed_at: z.string().datetime({ offset: true }),
  hierarchy: z.array(nativeRow).max(20),
  event_mappings: z.record(z.string(), z.unknown()).optional(),
  limitations: z.array(z.string().max(1000)).max(30).optional()
})

function project(
  payload: AdvertisingDecision,
  target: AdvertisingTarget,
  now: number
): AdvertisingEvidence | null {
  const statistics = nativeStatistics.safeParse(payload.statistics)
  if (
    !statistics.success ||
    normalizeCompany(payload.company) !== target.company ||
    payload.account_id !== target.accountId ||
    payload.operation.fact_coverage_complete !== true ||
    !payload.operation.insights_observed_at ||
    Date.parse(payload.operation.insights_observed_at) !== Date.parse(statistics.data.observed_at)
  ) {
    throw new Error(
      'The coordinator has no complete native advertising observation with verified metric freshness.'
    )
  }
  const matches = statistics.data.hierarchy.filter((row) => row.object_id === target.nativeId)
  if (matches.length > 1) {
    throw new Error('The native advertising identity is duplicated in source evidence.')
  }
  if (matches.length === 0) {
    return null
  }
  const row = matches[0]
  const campaign = row.level === 'campaign' ? row.object_id : row.campaign_id
  const adset = row.level === 'adset' ? row.object_id : row.level === 'ad' ? row.adset_id : null
  if (
    row.level !== target.objectType ||
    campaign !== target.campaignId ||
    adset !== target.adsetId
  ) {
    throw new Error(
      'The coordinator advertising target hierarchy does not match the requested object.'
    )
  }
  const today = row.metrics.today
  const mappedLead = statistics.data.event_mappings?.lead
  const leadEvent = typeof mappedLead === 'string' ? mappedLead : null
  const evidence = advertisingEvidence.safeParse({
    source: 'console.coordinator.statistics',
    target,
    name: row.name,
    currency: payload.money.currency,
    status: row.status,
    effectiveStatus: row.effective_status,
    measuredAt: statistics.data.observed_at,
    fetchedAt: new Date(now).toISOString(),
    dateStart: payload.windows.today.start,
    dateStop: payload.windows.today.end,
    timezone: payload.windows.timezone,
    leadEvent,
    budgetOwnerId: row.budget_owner_id,
    limitations: statistics.data.limitations ?? [],
    metrics: {
      spend: today.spend,
      revenue: today.attributed_revenue,
      purchases: today.purchases,
      registrations: today.registrations,
      leads: leadEvent ? today.leads : null,
      addToCarts: null,
      checkouts: today.checkouts,
      linkClicks: today.link_clicks,
      impressions: today.impressions,
      dailyBudget: row.owning_daily_budget,
      linkCpc: unitCost(today.spend, today.link_clicks),
      roas: unitCost(today.attributed_revenue, today.spend)
    }
  })
  if (!evidence.success) {
    throw new Error('Native advertising source evidence is incomplete.')
  }
  return evidence.data
}

/** Cached native observations retain their true observed_at; display-only fallback is refused. */
export async function fetchCoordinatorAdvertisingEvidence(
  targets: readonly AdvertisingTarget[],
  policy: AdvertisingRoutinePolicy,
  now?: number
): Promise<AdvertisingEvidence[]> {
  const found = new Map<string, AdvertisingEvidence>()
  let pages = 0
  let revision: string | null = null
  for (const campaignId of new Set(targets.map((target) => target.campaignId))) {
    const remaining = targets.filter((target) => target.campaignId === campaignId)
    for (let offset = 0; remaining.some((target) => !found.has(target.nativeId)); offset += 20) {
      if (++pages > 40) {
        throw new Error('Advertising source lookup exceeded its bounded page limit.')
      }
      const result = await consoleAdvertisingClient.decision({
        instanceId: `adops-${policy.company}`,
        section: 'statistics',
        offset,
        limit: 20,
        campaignId
      })
      if (!result.ok) {
        throw new Error('Current native advertising source evidence could not be read.')
      }
      const payload = result.data
      if (
        !payload.evidence_revision ||
        (revision !== null && revision !== payload.evidence_revision)
      ) {
        throw new Error('The native advertising observation changed during pagination.')
      }
      revision = payload.evidence_revision
      for (const target of remaining) {
        const evidence = project(payload, target, now ?? Date.now())
        if (evidence) {
          if (found.has(target.nativeId)) {
            throw new Error('Advertising evidence repeats a native target.')
          }
          found.set(target.nativeId, evidence)
        }
      }
      if (
        !payload.pagination ||
        payload.pagination.returned === 0 ||
        !payload.pagination.has_more
      ) {
        break
      }
    }
  }
  return targets.map((target) => {
    const evidence = found.get(target.nativeId)
    if (!evidence) {
      throw new Error('The native advertising target was not uniquely found.')
    }
    return evidence
  })
}
