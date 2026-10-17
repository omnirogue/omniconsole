import { z } from 'zod'
import { measure, optionalText, unitCost } from './console-advertising-leaves'

// ── GET /api/gtd/hub/api/sales/ads ────────────────────────────────────────────
export const SALES_COMPANIES = ['omnirogue', 'betacorp'] as const
export type SalesCompany = (typeof SALES_COMPANIES)[number]
export const salesCompany = z.enum(SALES_COMPANIES)
export const SALES_RANGE_DAYS = [1, 7, 30] as const
export type SalesRangeDays = (typeof SALES_RANGE_DAYS)[number]
export const salesRangeDays = z.union([z.literal(1), z.literal(7), z.literal(30)])
export const SALES_LEVELS = ['campaign', 'adset', 'ad'] as const
export const salesLevel = z.enum(SALES_LEVELS)
export const salesState = z.enum(['active', 'inactive', 'all'])
export const salesSegment = z.enum(['dtc', 'enterprise', 'other'])
export type SalesSegment = z.infer<typeof salesSegment>

const pauseReceipt = z.object({
  status: z.enum(['confirmed', 'pending', 'failed']),
  action_id: optionalText,
  request_id: optionalText,
  message: z.string(),
  observed_at: optionalText,
  reason: optionalText
})

/**
 * One advertising object at one level. The derived block is computed here rather
 * than taken from the provider so the cost shown is always spend ÷ the count in
 * the same row: a provider's all-click CPC would disagree with the link clicks
 * beside it.
 */
export const salesAdRow = z
  .object({
    id: z.string().min(1),
    platform_id: z.string().min(1),
    level: salesLevel,
    name: z.string(),
    campaign_id: optionalText,
    campaign_name: optionalText,
    parent_id: optionalText,
    segment: salesSegment.catch('other'),
    status: optionalText,
    effective_status: optionalText,
    spend: measure,
    link_clicks: measure,
    cpc_link: measure,
    checkouts: measure,
    add_to_carts: measure,
    impressions: measure,
    reach: measure,
    revenue: measure.optional().default(null),
    leads: measure,
    /** Which Meta event this account maps to "Lead"; without it a CPL is not a CPL. */
    lead_event: optionalText,
    registrations: measure,
    purchases: measure,
    daily_budget: measure.optional().default(null),
    can_pause: z.boolean().catch(false),
    pause_blocker: optionalText,
    measured_at: optionalText,
    last_pause_receipt: pauseReceipt.nullable().optional().catch(null),
    pause_revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional()
      .catch(null)
  })
  .passthrough()
  .transform((row) => ({
    ...row,
    cpc_link: unitCost(row.spend, row.link_clicks),
    cpl: row.lead_event ? unitCost(row.spend, row.leads) : null,
    cost_per_registration: unitCost(row.spend, row.registrations),
    cost_per_add_to_cart: unitCost(row.spend, row.add_to_carts),
    cost_per_checkout: unitCost(row.spend, row.checkouts),
    cost_per_purchase: unitCost(row.spend, row.purchases),
    roas: unitCost(row.revenue, row.spend),
    cpm:
      row.impressions !== null && row.impressions > 0 && row.spend !== null
        ? (row.spend / row.impressions) * 1000
        : null,
    ctr_link:
      row.impressions !== null && row.impressions > 0 && row.link_clicks !== null
        ? (row.link_clicks / row.impressions) * 100
        : null,
    frequency: unitCost(row.impressions, row.reach)
  }))

export const salesAdsReport = z
  .object({
    company: salesCompany,
    account_id: z.string(),
    currency: z.string().nullable().catch(null),
    measured_at: optionalText,
    date_start: z.string(),
    date_stop: z.string(),
    timezone: z.string(),
    fetched_at: z.string(),
    partial: z.boolean().optional().default(false),
    rows: z.array(salesAdRow),
    sources: z
      .array(
        z.object({
          name: z.string(),
          ok: z.boolean(),
          note: optionalText,
          error: optionalText,
          fetched_at: optionalText
        })
      )
      .optional()
      .default([]),
    can_pause: z.boolean().catch(false)
  })
  .passthrough()

export type SalesAdRow = z.infer<typeof salesAdRow>
export type SalesAdsReport = z.infer<typeof salesAdsReport>

/** ACTIVE at its own level AND not switched off by an ancestor. */
export function isActiveAdObject(row: Pick<SalesAdRow, 'status' | 'effective_status'>): boolean {
  return row.status?.toUpperCase() === 'ACTIVE' && row.effective_status?.toUpperCase() === 'ACTIVE'
}

export function isPausedAdObject(row: Pick<SalesAdRow, 'status' | 'effective_status'>): boolean {
  return [row.status, row.effective_status].some((status) =>
    ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(status?.toUpperCase() ?? '')
  )
}
