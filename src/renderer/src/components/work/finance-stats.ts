import { translate } from '@/i18n/i18n'
import {
  marginPct,
  THIN_MARGIN_PCT,
  type FinanceCompany,
  type FinanceWindow,
  type ScorecardCompany
} from '../../../../shared/console-scorecard-contract'
import { statNumber as number, type Stat } from './stats-model'

/**
 * Finance and admin: revenue → API cost → provider → model → feature → margin.
 *
 * The rule that shapes this file: `reported` is authoritative. A field the source
 * did not answer is unknown even when a legacy zero sits in its place, and a
 * company that bills no API tenant gets no API-cost tile rather than a $0.00 one.
 */

export function financeAmount(
  window: FinanceWindow | null | undefined,
  field: 'revenue' | 'ad_spend' | 'api_cost' | 'pnl'
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
  // A truncated Stripe page undercounts revenue, and therefore P&L with it.
  if (window.stripe_truncated === true && (field === 'revenue' || field === 'pnl')) {
    return null
  }
  return number(window[field])
}

/**
 * The same rule applied to the company's own day row, which is the fallback when the
 * finance block has no window for this company.
 *
 * Why a function and not `?? company.today.revenue`: that `??` was the defect. A value
 * the window correctly withheld came straight back from the raw day, so a truncated or
 * unreported figure rendered as a measurement — the exact thing `financeAmount` exists
 * to prevent, undone one line later.
 */
function dayAmount(
  today: ScorecardCompany['today'],
  field: 'revenue' | 'ad_spend' | 'api_cost' | 'pnl'
): number | null {
  if (!today) {
    return null
  }
  if (today.reported !== undefined && !today.reported.includes(field)) {
    return null
  }
  if (today.stripe_truncated === true && (field === 'revenue' || field === 'pnl')) {
    return null
  }
  if (field === 'api_cost' && today.api_cost_available === false) {
    return null
  }
  return number(today[field])
}

function marginTone(value: number | null): Stat['tone'] {
  if (value === null) {
    return 'neutral'
  }
  return value < 0 ? 'bad' : value < THIN_MARGIN_PCT ? 'warn' : 'good'
}

/** Why a margin is missing, in the collector's own terms. */
function marginWithheld(window: FinanceWindow | null | undefined): string | undefined {
  const quality = window?.financial_quality?.pnl
  if (quality?.state === 'partial') {
    const observed = number(quality.observed)
    const expected = number(quality.expected)
    return observed !== null && expected !== null
      ? `Reported P&L on ${observed} of ${expected} days, so the window has no total.`
      : 'Reported P&L covers only part of this window.'
  }
  if (quality?.state !== undefined && quality.state !== 'reported') {
    return 'P&L is unavailable for this window.'
  }
  return undefined
}

/**
 * Finance and admin for one company. The API-cost tile is absent — not zero and
 * not an em dash — for a company that reports no API cost at all.
 */
export function financeStats(
  company: ScorecardCompany | undefined,
  finance: FinanceCompany | undefined
): Stat[] {
  const today = finance?.today
  const stats: Stat[] = [
    {
      id: 'revenue',
      label: translate('work.finance.revenueToday', 'Revenue today'),
      value: financeAmount(today, 'revenue') ?? dayAmount(company?.today, 'revenue'),
      kind: 'money',
      caption: revenueCaption(company)
    }
  ]
  const billsApi = company?.today?.api_cost_available !== false
  if (billsApi) {
    const breakdown = finance?.api_cost_today
    const apiCost =
      number(breakdown?.total) ??
      financeAmount(today, 'api_cost') ??
      dayAmount(company?.today, 'api_cost')
    stats.push({
      id: 'api_cost',
      label: translate('work.finance.apiCostToday', 'API cost today'),
      value: apiCost,
      kind: 'money',
      caption:
        number(breakdown?.requests) !== null
          ? `over ${number(breakdown?.requests)?.toLocaleString('en-US')} requests`
          : undefined,
      // Why keyed on the value and not on two of its three sources: the note said the
      // source did not answer while the tile showed a figure the third source supplied.
      withheld: apiCost === null ? 'The cost source did not answer today.' : undefined
    })
    stats.push({
      id: 'api_cost_7d',
      label: translate('work.finance.apiCost7d', 'API cost 7d'),
      value: number(finance?.api_cost_7d?.total),
      kind: 'money'
    })
  }
  // Why the same fallback as its three siblings: without it, a company with no finance
  // window but a reported P&L on its day row showed unknown where the figure exists.
  const pnl = financeAmount(today, 'pnl') ?? dayAmount(company?.today, 'pnl')
  const margin = marginPct(today)
  stats.push(
    {
      id: 'ad_spend',
      label: translate('work.finance.adSpendToday', 'Ad spend today'),
      value: financeAmount(today, 'ad_spend') ?? dayAmount(company?.today, 'ad_spend'),
      kind: 'money',
      caption: company?.today?.ad_spend_note ?? undefined
    },
    {
      id: 'pnl',
      label: translate('work.finance.reportedPLToday', 'Reported P&L today'),
      value: pnl,
      kind: 'money',
      tone: pnl === null ? 'neutral' : pnl < 0 ? 'bad' : 'good',
      caption: translate('work.finance.costCompletenessUnknown', 'cost completeness unknown')
    },
    {
      id: 'margin_today',
      label: translate('work.finance.reportedMarginToday', 'Reported margin today'),
      value: margin,
      kind: 'percent',
      tone: marginTone(margin),
      caption: translate('work.finance.reportedPLRevenue', 'reported P&L ÷ revenue'),
      withheld: margin === null ? marginWithheld(today) : undefined
    },
    {
      id: 'margin_7d',
      label: translate('work.finance.reportedMargin7d', 'Reported margin 7d'),
      value: marginPct(finance?.week),
      kind: 'percent',
      tone: marginTone(marginPct(finance?.week)),
      withheld: marginPct(finance?.week) === null ? marginWithheld(finance?.week) : undefined
    },
    {
      id: 'margin_30d',
      label: translate('work.finance.reportedMargin30d', 'Reported margin 30d'),
      value: marginPct(finance?.month),
      kind: 'percent',
      tone: marginTone(marginPct(finance?.month)),
      withheld: marginPct(finance?.month) === null ? marginWithheld(finance?.month) : undefined
    }
  )
  return stats
}

/** Where the revenue came from, in the shape the company actually reports it. */
function revenueCaption(company: ScorecardCompany | undefined): string | undefined {
  const today = company?.today
  if (!today) {
    return undefined
  }
  const usd = (value: number | null): string =>
    value === null ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  // ACME splits a gateway from Stripe; everyone else splits new cash from rebills.
  if (number(today.gatewayone_cash) !== null || number(today.stripe_direct_cash) !== null) {
    return `GatewayOne ${usd(number(today.gatewayone_cash))} · Stripe direct ${usd(number(today.stripe_direct_cash))}`
  }
  if (number(today.new_cash) !== null || number(today.rebill_cash) !== null) {
    const customers = number(today.new_customers)
    const rebills = number(today.rebills)
    return `new ${usd(number(today.new_cash))}${customers === null ? '' : ` (${customers})`} · rebills ${usd(number(today.rebill_cash))}${rebills === null ? '' : ` (${rebills})`}`
  }
  return undefined
}

/** Customer service for one company, in the order the desk is read. */
