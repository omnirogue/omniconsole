import { unitCost } from '../../shared/console-advertising-leaves'
import {
  advertisingTarget,
  type AdvertisingEvidence,
  type AdvertisingTarget
} from '../../shared/typesafe-advertising'

const EVENTS = {
  purchases: 'offsite_conversion.fb_pixel_purchase',
  registrations: 'offsite_conversion.fb_pixel_complete_registration',
  leads: 'offsite_conversion.fb_pixel_lead',
  addToCarts: 'offsite_conversion.fb_pixel_add_to_cart',
  checkouts: 'offsite_conversion.fb_pixel_initiate_checkout'
} as const
const EVENT_LIMITATION =
  'Conversions use only exact Meta pixel event types; aggregate aliases and non-Meta signup sources are excluded.'

type Metrics = AdvertisingEvidence['metrics']
type Projection = { metrics: Metrics; leadEvent: string | null; limitations: string[] }

function invalid(reason: string): never {
  throw new Error(`Local Meta insights ${reason}.`)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('contain a malformed record')
  }
  return value as Record<string, unknown>
}

function measure(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null
  }
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
  ) {
    invalid('contain a malformed measure')
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    invalid('contain a malformed measure')
  }
  return parsed
}

function actions(value: unknown): Map<string, number | null> {
  const result = new Map<string, number | null>()
  if (value === undefined || value === null) {
    return result
  }
  if (!Array.isArray(value) || value.length > 1000) {
    invalid('contain malformed action metrics')
  }
  for (const item of value) {
    const entry = record(item)
    const event = entry.action_type
    if (typeof event !== 'string' || !event.length || event.length > 200 || result.has(event)) {
      invalid('contain malformed or duplicate action types')
    }
    result.set(event, measure(entry.value))
  }
  return result
}

function emptyMetrics(): Metrics {
  return {
    spend: null,
    revenue: null,
    purchases: null,
    registrations: null,
    leads: null,
    addToCarts: null,
    checkouts: null,
    linkClicks: null,
    impressions: null,
    dailyBudget: null,
    linkCpc: null,
    roas: null
  }
}

export function localMetaInsightFields(objectType: 'adset' | 'ad'): string {
  return [
    'account_id',
    'campaign_id',
    'adset_id',
    ...(objectType === 'ad' ? ['ad_id'] : []),
    'date_start',
    'date_stop',
    'spend',
    'impressions',
    'inline_link_clicks',
    'actions',
    'action_values'
  ].join(',')
}

export function parseLocalMetaMetrics(
  rows: unknown[],
  target: AdvertisingTarget,
  date: string
): Projection {
  const parsedTarget = advertisingTarget.safeParse(target)
  const dateValue = Date.parse(`${date}T00:00:00.000Z`)
  if (
    !parsedTarget.success ||
    target.objectType === 'campaign' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(dateValue) ||
    new Date(dateValue).toISOString().slice(0, 10) !== date
  ) {
    invalid('require a valid ad or ad-set target and date')
  }
  if (!Array.isArray(rows) || rows.length > 1) {
    invalid('contain duplicate or unexpected rows')
  }
  const metrics = emptyMetrics()
  const limitations = [EVENT_LIMITATION]
  if (!rows.length) {
    limitations.push('Meta returned no today insight row; performance metrics remain unknown.')
    return { metrics, leadEvent: null, limitations }
  }
  const row = record(rows[0])
  if (
    row.account_id !== target.accountId.slice(4) ||
    row.campaign_id !== target.campaignId ||
    row.adset_id !== target.adsetId ||
    (target.objectType === 'ad' ? row.ad_id !== target.nativeId : row.ad_id != null)
  ) {
    invalid('do not match the exact native target hierarchy')
  }
  if (row.date_start !== date || row.date_stop !== date) {
    invalid('do not match the account date')
  }
  const counts = actions(row.actions)
  const values = actions(row.action_values)
  metrics.spend = measure(row.spend)
  metrics.impressions = measure(row.impressions)
  metrics.linkClicks = measure(row.inline_link_clicks)
  metrics.revenue = values.get(EVENTS.purchases) ?? null
  for (const key of Object.keys(EVENTS) as (keyof typeof EVENTS)[]) {
    metrics[key] = counts.get(EVENTS[key]) ?? null
  }
  metrics.linkCpc = unitCost(metrics.spend, metrics.linkClicks)
  metrics.roas = unitCost(metrics.revenue, metrics.spend)
  if (
    (metrics.linkCpc !== null && !Number.isFinite(metrics.linkCpc)) ||
    (metrics.roas !== null && !Number.isFinite(metrics.roas))
  ) {
    invalid('contain an unrepresentable derived measure')
  }
  if (Object.entries(metrics).some(([key, value]) => key !== 'dailyBudget' && value === null)) {
    limitations.push('Unreported or undefined metrics remain unknown; missing events are not zero.')
  }
  return {
    metrics,
    leadEvent: counts.has(EVENTS.leads) ? EVENTS.leads : null,
    limitations
  }
}
