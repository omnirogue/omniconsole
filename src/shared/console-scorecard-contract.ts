import { z } from 'zod'
import {
  countOrZero,
  financialField,
  financialSources,
  looseBool,
  looseCount,
  looseNumber,
  looseText,
  scorecardSource
} from './console-scorecard-leaves'
import { financeCompany, portfolioFinance } from './console-scorecard-finance'
import { csCompany, portfolioCustomerService } from './console-scorecard-service'
import { opsCompany, portfolioOperations } from './console-scorecard-operations'
import { providerBills } from './console-scorecard-provider-bills'

// ── the money scorecard (GET /api/gtd/estate/scorecard) ───────────────────────
// One document, four audiences: the day's money per company, the finance detail
// with its API-cost breakdowns, the customer-service desks, and operations.
//
// Decoded loosely on numbers — every figure may be absent or null, and an
// unreported field is unknown rather than zero — and tolerantly on structure, so
// a newer collector never breaks an older client. `totals` is omitted for a
// person whose company scope does not cover the whole estate.

export * from './console-scorecard-leaves'
export * from './console-scorecard-finance'
export * from './console-scorecard-service'
export * from './console-scorecard-operations'
export * from './console-scorecard-provider-bills'

export const scorecardDay = z
  .object({
    date: z.string().optional(),
    reported: z.array(financialField).optional(),
    stripe_truncated: z.boolean().optional(),
    revenue: looseNumber,
    ad_spend: looseNumber,
    api_cost: looseNumber,
    pnl: looseNumber
  })
  .passthrough()

/** Today, with the cash detail the collector adds for a company that sells. */
export const scorecardToday = scorecardDay
  .extend({
    financial_sources: financialSources,
    /** False for a company that bills no API tenant: the tile is omitted, not zeroed. */
    api_cost_available: z.boolean().optional(),
    new_cash: looseNumber,
    new_customers: looseCount,
    rebill_cash: looseNumber,
    rebills: looseCount,
    purchases: looseCount,
    /** ACME only: the GatewayOne side of its revenue, beside Stripe's. */
    gatewayone_cash: looseNumber,
    gatewayone_new: looseNumber,
    gatewayone_recurring: looseNumber,
    gatewayone_count: looseCount,
    stripe_direct_cash: looseNumber,
    ad_spend_note: looseText
  })
  .passthrough()

export const scorecardCompany = z
  .object({
    financial_sources: financialSources,
    slug: z.string(),
    name: z.string().optional(),
    today: scorecardToday.optional(),
    days: z.array(scorecardDay).default([]),
    sources: z.array(scorecardSource).default([])
  })
  .passthrough()

// ── the live ad account block the ad dashboards read ──────────────────────────
const adsMetric = z
  .object({
    spend: looseNumber,
    purchases: looseCount,
    purchase_value: looseNumber,
    registrations: looseCount,
    checkouts: looseCount,
    link_clicks: looseCount,
    cpc_link: looseNumber,
    pixel_roas: looseNumber
  })
  .passthrough()

export const adsAccount = z
  .object({
    company: looseText,
    account_id: looseText,
    timezone: looseText,
    today: adsMetric
      .extend({
        new_cash: looseNumber,
        new_customers: looseCount,
        rebill_cash: looseNumber,
        rebills: looseCount,
        cash_roas: looseNumber
      })
      .passthrough()
      .optional(),
    hourly: z.array(adsMetric.extend({ hour: countOrZero }).passthrough()).default([]),
    adsets: z
      .array(
        adsMetric
          .extend({
            adset_id: looseText,
            adset: looseText,
            campaign: looseText,
            campaign_id: looseText
          })
          .passthrough()
      )
      .default([]),
    daily: z
      .array(
        z
          .object({
            date: z.string(),
            spend: looseNumber,
            purchases: looseCount,
            purchase_value: looseNumber,
            registrations: looseCount,
            stripe_cash: looseNumber,
            cash_roas: looseNumber
          })
          .passthrough()
      )
      .default([]),
    funnelkit: z
      .object({ purchases: looseCount, revenue: looseNumber })
      .passthrough()
      .nullable()
      .optional(),
    sources: z.array(scorecardSource).default([])
  })
  .passthrough()

export const scorecardDocument = z
  .object({
    generated_at: z.string(),
    timezone: z.string().optional(),
    today: z.string(),
    companies: z.array(scorecardCompany),
    /** Per ad account: today's tiles, the hourly pace, every ad set, 30 days. */
    ads_accounts: z.array(adsAccount).default([]),
    sources: z.array(scorecardSource).default([]),
    collector_seconds: looseNumber,
    totals: z
      .object({
        today: scorecardDay.optional(),
        finance: portfolioFinance.nullable().optional(),
        customer_service: portfolioCustomerService.nullable().optional(),
        operations: portfolioOperations.nullable().optional()
      })
      .passthrough()
      .optional(),
    finance: z.record(z.string(), financeCompany).optional(),
    /** Keyed by company slug; absent for a company with no desk. */
    customer_service: z.record(z.string(), csCompany).optional(),
    /** Keyed by company slug. */
    operations: z.record(z.string(), opsCompany).optional(),
    /**
     * What the vendors billed beside what both brands logged, by UTC day. Absent
     * for a company-scoped reader; a malformed block is null, never a failed document.
     */
    provider_bills: providerBills.nullable().optional().catch(null),
    /** Present when the relay pruned the document to the reader's companies. */
    scope: z
      .object({ companies: z.array(z.string()), totals_omitted: z.boolean().default(false) })
      .optional(),
    stale_s: looseNumber,
    file_mtime: looseText,
    partial: looseBool
  })
  .passthrough()

export type ScorecardDay = z.infer<typeof scorecardDay>
export type ScorecardToday = z.infer<typeof scorecardToday>
export type ScorecardCompany = z.infer<typeof scorecardCompany>
export type AdsAccount = z.infer<typeof adsAccount>
export type ScorecardDocument = z.infer<typeof scorecardDocument>

/** Past this age the document describes a state of the world that has moved on. */
export const SCORECARD_STALE_MINUTES = 20

export function financeFor(
  document: ScorecardDocument | null | undefined,
  slug: string
): z.infer<typeof financeCompany> | undefined {
  return document?.finance?.[slug]
}
export function serviceFor(
  document: ScorecardDocument | null | undefined,
  slug: string
): z.infer<typeof csCompany> | undefined {
  return document?.customer_service?.[slug]
}
export function operationsFor(
  document: ScorecardDocument | null | undefined,
  slug: string
): z.infer<typeof opsCompany> | undefined {
  return document?.operations?.[slug]
}
export function adsAccountFor(
  document: ScorecardDocument | null | undefined,
  slug: string
): AdsAccount | undefined {
  return document?.ads_accounts.find((account) => account.company === slug)
}
