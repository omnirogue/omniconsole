import {
  unitCost,
  type SalesAdRow,
  type SalesAdsReport,
  type SalesSegment
} from '../../../../shared/console-advertising-contract'

/**
 * Advertising arithmetic. Everything here either sums measured rows or says it
 * cannot.
 *
 *  - A campaign with no insights is not a campaign that spent nothing. It is
 *    excluded from every subtotal and counted in `unmeasured` instead.
 *  - One missing value makes the whole total unknown, rather than an undercount
 *    presented as a fact.
 *  - When any source is incomplete, the measured subtotals still show, but derived
 *    profit and ROAS are withheld: a ratio over a partial numerator is a wrong
 *    number, not an approximate one.
 */

export type AdTotals = {
  spend: number | null
  revenue: number | null
  /** Attributed revenue less ad spend. Not net profit: it excludes every other cost. */
  profit: number | null
  roas: number | null
  clicks: number | null
  leads: number | null
  registrations: number | null
  addToCarts: number | null
  checkouts: number | null
  purchases: number | null
  impressions: number | null
  costPerClick: number | null
  costPerLead: number | null
  costPerRegistration: number | null
  costPerAddToCart: number | null
  costPerCheckout: number | null
  costPerPurchase: number | null
  /** True when a source failed, a row was duplicated, or the provider said partial. */
  partial: boolean
  /** Objects in scope that reported no insight at all. */
  unmeasured: number
  /** Whether any Lead event is mapped; without one a CPL is not a CPL. */
  leadEvent: string | null
}

export const UNKNOWN_TOTALS: AdTotals = {
  spend: null,
  revenue: null,
  profit: null,
  roas: null,
  clicks: null,
  leads: null,
  registrations: null,
  addToCarts: null,
  checkouts: null,
  purchases: null,
  impressions: null,
  costPerClick: null,
  costPerLead: null,
  costPerRegistration: null,
  costPerAddToCart: null,
  costPerCheckout: null,
  costPerPurchase: null,
  partial: false,
  unmeasured: 0,
  leadEvent: null
}

/** Two decimals, shared by every fold here and by the cash window. */
export const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100

type SummableField =
  | 'spend'
  | 'revenue'
  | 'link_clicks'
  | 'leads'
  | 'registrations'
  | 'add_to_carts'
  | 'checkouts'
  | 'purchases'
  | 'impressions'

/**
 * A sum only when every row in scope reported the field. One missing value makes
 * the total unknown rather than an undercount presented as a fact.
 */
function sum(rows: readonly SalesAdRow[], field: SummableField): number | null {
  return rows.length > 0 && rows.every((row) => row[field] !== null)
    ? round(rows.reduce((total, row) => total + (row[field] ?? 0), 0))
    : null
}

/**
 * One level of one account, each provider object counted once. Parents and
 * children are never added together — the caller passes rows of a single level.
 */
export function segmentTotals(
  report: SalesAdsReport | null,
  segment?: SalesSegment,
  level: SalesAdRow['level'] = 'campaign'
): AdTotals {
  // Why: a non-USD account cannot be summed into a dollar figure here.
  if (!report || report.currency !== 'USD') {
    return UNKNOWN_TOTALS
  }
  const scoped = report.rows.filter(
    (row) => row.level === level && (!segment || row.segment === segment)
  )
  const seen = new Set<string>()
  let duplicate = false
  const unique = scoped.filter((row) => {
    if (seen.has(row.platform_id)) {
      duplicate = true
      return false
    }
    seen.add(row.platform_id)
    return true
  })
  // A historical object with no insight row is not an observed zero.
  const measured = unique.filter((row) => row.spend !== null || row.revenue !== null)
  const partial = report.partial || duplicate || report.sources.some((source) => !source.ok)
  const spend = sum(measured, 'spend')
  const revenue = sum(measured, 'revenue')
  const clicks = sum(measured, 'link_clicks')
  const leadEvent = measured.find((row) => row.lead_event !== null)?.lead_event ?? null
  const leads = leadEvent === null ? null : sum(measured, 'leads')
  const registrations = sum(measured, 'registrations')
  const addToCarts = sum(measured, 'add_to_carts')
  const checkouts = sum(measured, 'checkouts')
  const purchases = sum(measured, 'purchases')
  return {
    spend,
    revenue,
    // Withheld on a partial report: a ratio over an incomplete numerator is wrong.
    profit: !partial && spend !== null && revenue !== null ? round(revenue - spend) : null,
    roas: !partial ? unitCost(revenue, spend) : null,
    clicks,
    leads,
    registrations,
    addToCarts,
    checkouts,
    purchases,
    impressions: sum(measured, 'impressions'),
    costPerClick: unitCost(spend, clicks),
    costPerLead: unitCost(spend, leads),
    costPerRegistration: unitCost(spend, registrations),
    costPerAddToCart: unitCost(spend, addToCarts),
    costPerCheckout: unitCost(spend, checkouts),
    costPerPurchase: unitCost(spend, purchases),
    partial,
    unmeasured: unique.length - measured.length,
    leadEvent
  }
}

/** Several segments added, on the same rules. Unknown in, unknown out. */
export function combineTotals(parts: readonly AdTotals[]): AdTotals {
  const fields = [
    'spend',
    'revenue',
    'clicks',
    'leads',
    'registrations',
    'addToCarts',
    'checkouts',
    'purchases',
    'impressions'
  ] as const
  const result: AdTotals = { ...UNKNOWN_TOTALS }
  for (const field of fields) {
    result[field] =
      parts.length > 0 && parts.every((part) => part[field] !== null)
        ? round(parts.reduce((total, part) => total + (part[field] ?? 0), 0))
        : null
  }
  result.partial = parts.some((part) => part.partial)
  result.unmeasured = parts.reduce((total, part) => total + part.unmeasured, 0)
  result.leadEvent = parts.find((part) => part.leadEvent !== null)?.leadEvent ?? null
  result.profit =
    !result.partial && result.spend !== null && result.revenue !== null
      ? round(result.revenue - result.spend)
      : null
  result.roas = !result.partial ? unitCost(result.revenue, result.spend) : null
  result.costPerClick = unitCost(result.spend, result.clicks)
  result.costPerLead = unitCost(result.spend, result.leads)
  result.costPerRegistration = unitCost(result.spend, result.registrations)
  result.costPerAddToCart = unitCost(result.spend, result.addToCarts)
  result.costPerCheckout = unitCost(result.spend, result.checkouts)
  result.costPerPurchase = unitCost(result.spend, result.purchases)
  return result
}
