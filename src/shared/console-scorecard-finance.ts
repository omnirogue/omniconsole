import { z } from 'zod'
import {
  financialField,
  financialSources,
  type FinancialField,
  looseBool,
  looseCount,
  looseNumber,
  looseText,
  moneyCoverage,
  scorecardSource
} from './console-scorecard-leaves'

/**
 * Finance and API cost: revenue → API cost → provider → model → feature → margin.
 *
 * Two rules the collector writes into this shape and the UI must keep:
 *  - `reported` names the fields a source actually answered. A field absent from
 *    it is unknown even when the legacy numeric default left a 0 behind.
 *  - `api_cost` is `null` for a company that reports none at all (ApexLabs and
 *    ACME bill no tenant), which is why the tile is OMITTED rather than shown as
 *    $0.00 — a zero would read as "we measured, and it was nothing".
 */

/** One window's money, with the coverage that decides whether to believe it. */
export const financeWindow = z
  .object({
    financial_quality: z.record(z.string(), moneyCoverage).optional(),
    reported: z.array(financialField).optional(),
    stripe_truncated: looseBool,
    pnl_reported: looseBool,
    revenue: looseNumber,
    ad_spend: looseNumber,
    api_cost: looseNumber,
    pnl: looseNumber,
    /** pnl ÷ revenue × 100; null when there was no revenue to divide by. */
    margin_pct: looseNumber
  })
  .passthrough()

/** One line of an API-cost breakdown: a provider, model, category or feature. */
export const costRow = z
  .object({ name: z.string(), cost: looseNumber, requests: looseCount })
  .passthrough()

export const costDimensionCoverage = z
  .object({
    state: looseText,
    returned: looseCount,
    supplied: looseCount,
    truncated: looseBool
  })
  .passthrough()

export const COST_DIMENSIONS = ['by_provider', 'by_model', 'by_category', 'by_agent'] as const
export type CostDimension = (typeof COST_DIMENSIONS)[number]

/**
 * API cost for one window, and the four ways it splits. A dimension the collector
 * did not send is `null` — distinct from an empty list, which means it looked and
 * found nothing.
 */
export const costBreakdown = z
  .object({
    dimension_quality: z.record(z.string(), costDimensionCoverage).optional(),
    total: looseNumber,
    requests: looseCount,
    by_provider: z.array(costRow).nullable().optional(),
    by_model: z.array(costRow).nullable().optional(),
    by_category: z.array(costRow).nullable().optional(),
    /** The product or feature the spend came from (the platform's agent slug). */
    by_agent: z.array(costRow).nullable().optional()
  })
  .passthrough()

export const financeCompany = z
  .object({
    financial_sources: financialSources,
    breakdown_sources: z.array(scorecardSource).optional(),
    slug: looseText,
    today: financeWindow.optional(),
    week: financeWindow.optional(),
    month: financeWindow.optional(),
    api_cost_today: costBreakdown.nullable().optional(),
    api_cost_7d: costBreakdown.nullable().optional(),
    sources: z.array(scorecardSource).optional()
  })
  .passthrough()

export const portfolioFinance = z
  .object({
    today: financeWindow.optional(),
    week: financeWindow.optional(),
    month: financeWindow.optional()
  })
  .passthrough()

export type FinanceWindow = z.infer<typeof financeWindow>
export type CostRow = z.infer<typeof costRow>
export type CostBreakdown = z.infer<typeof costBreakdown>
export type FinanceCompany = z.infer<typeof financeCompany>
export type CostDimensionCoverage = z.infer<typeof costDimensionCoverage>

/** The rows of one dimension, or null when the collector never sent that split. */
export function costDimension(
  breakdown: CostBreakdown | null | undefined,
  dimension: CostDimension
): CostRow[] | null {
  return breakdown?.[dimension] ?? null
}

/** A field of a window, or null when the source did not vouch for it. */
export function reportedAmount(
  window: FinanceWindow | null | undefined,
  field: FinancialField
): number | null {
  if (!window) {
    return null
  }
  if (window.reported !== undefined && !window.reported.includes(field)) {
    return null
  }
  if (field === 'pnl' && window.pnl_reported === false) {
    return null
  }
  // A truncated Stripe page undercounts revenue, and P&L with it.
  if (window.stripe_truncated === true && (field === 'revenue' || field === 'pnl')) {
    return null
  }
  const value = window[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A margin only when revenue was read and was positive. A margin over no revenue
 * is not 0%, it is nothing, and a negative denominator makes the sign meaningless.
 *
 * Both operands go through `reportedAmount`. Dividing the raw fields would compute a
 * margin from figures the window itself withheld — a partial P&L or a truncated
 * revenue — and a derived ratio over a withheld operand is exactly what the partial
 * rule exists to suppress. A supplied `margin_pct` is only trusted when the source
 * also vouched for the two figures behind it.
 */
export function marginPct(window: FinanceWindow | null | undefined): number | null {
  const revenue = reportedAmount(window, 'revenue')
  const pnl = reportedAmount(window, 'pnl')
  if (revenue === null || pnl === null) {
    return null
  }
  const supplied = window?.margin_pct
  if (typeof supplied === 'number' && Number.isFinite(supplied)) {
    return supplied
  }
  return revenue > 0 ? (pnl / revenue) * 100 : null
}

/** Below this, a margin is worth a second look rather than a green tick. */
export const THIN_MARGIN_PCT = 15
