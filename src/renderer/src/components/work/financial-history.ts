import type {
  ScorecardCompany,
  ScorecardDay,
  ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/**
 * The seven complete days behind today, per metric, with a fixed cohort.
 *
 * Three rules make this honest rather than merely plotted:
 *  - The days are counted from the COLLECTOR's date, in UTC arithmetic. Reading
 *    the viewer's clock would shift the window on a machine in another timezone
 *    and silently relabel every point.
 *  - Each metric has its own cohort: the companies that reported it at least once
 *    in the window. A day's total is emitted only when EVERY cohort member
 *    reported, otherwise it is `null` and the line breaks. A sum over four of five
 *    companies drawn as a total is a dip that never happened.
 *  - Historical P&L is the collector's own number, never revenue minus ad spend.
 *    Subtracting two fields it did not mean to pair invents a figure.
 */

export const TREND_METRICS = ['revenue', 'ad_spend', 'api_cost', 'pnl'] as const
export type TrendMetric = (typeof TREND_METRICS)[number]

export type TrendPoint = { date: string; value: number | null }
export type TrendSeries = {
  metric: TrendMetric
  label: string
  points: TrendPoint[]
  /** Companies that reported this metric at least once in the window. */
  cohort: string[]
  /** Days in the window where every cohort member reported. */
  covered: number
}
export type FinancialHistory = {
  start: string
  end: string
  days: string[]
  series: TrendSeries[]
  notes: string[]
}

const METRIC_LABEL: Record<TrendMetric, string> = {
  revenue: 'Revenue',
  ad_spend: 'Ad spend',
  api_cost: 'API cost',
  pnl: 'Reported P&L'
}

/** The seven dates ending the day before the collector's own today. */
export function completeDays(today: string, count = 7): string[] {
  const end = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(end)) {
    return []
  }
  return Array.from({ length: count }, (_, index) =>
    new Date(end - (count - index) * 86_400_000).toISOString().slice(0, 10)
  )
}

/** A day of one company, or null when the document carries no single row for it. */
function dayOf(
  company: ScorecardCompany,
  date: string
): { day: ScorecardDay | null; duplicate: boolean } {
  const matches = company.days.filter((row) => row.date === date)
  if (matches.length === 1) {
    return { day: matches[0], duplicate: false }
  }
  return { day: null, duplicate: matches.length > 1 }
}

/** One company's figure for one metric on one day, or null. */
function figureOf(day: ScorecardDay | null, metric: TrendMetric): number | null {
  if (!day) {
    return null
  }
  if (day.reported !== undefined && !day.reported.includes(metric)) {
    return null
  }
  // A truncated Stripe page undercounts revenue, and P&L with it. Ad spend is
  // a separate source and survives.
  if (day.stripe_truncated === true && (metric === 'revenue' || metric === 'pnl')) {
    return null
  }
  const value = day[metric]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function financialHistory(
  document: ScorecardDocument | null | undefined
): FinancialHistory | null {
  if (!document) {
    return null
  }
  const days = completeDays(document.today)
  if (days.length === 0) {
    return null
  }
  const notes: string[] = []
  // Why first, and not inside the cohort walk: a company whose only rows for a
  // date are duplicates reports nothing for that date, so it never joins the
  // cohort — and the note explaining its absence would never be written either.
  for (const company of document.companies) {
    for (const date of days) {
      if (dayOf(company, date).duplicate) {
        notes.push(
          `${company.name ?? company.slug} reported ${date} more than once, so that day is excluded.`
        )
      }
    }
  }
  const series: TrendSeries[] = []
  for (const metric of TREND_METRICS) {
    // The cohort is fixed for the whole window: a company that joined midweek
    // must not make the earlier days look smaller than they were.
    const cohort = document.companies.filter((company) =>
      days.some((date) => figureOf(dayOf(company, date).day, metric) !== null)
    )
    const points: TrendPoint[] = days.map((date) => {
      const figures = cohort.map((company) => figureOf(dayOf(company, date).day, metric))
      const complete = figures.length > 0 && figures.every((value) => value !== null)
      return {
        date,
        value: complete ? figures.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null
      }
    })
    series.push({
      metric,
      label: METRIC_LABEL[metric],
      points,
      cohort: cohort.map((company) => company.name ?? company.slug),
      covered: points.filter((point) => point.value !== null).length
    })
  }
  const thin = series.filter((entry) => entry.cohort.length > 0 && entry.covered < days.length)
  for (const entry of thin) {
    notes.push(
      `${entry.label} has ${entry.covered} of ${days.length} complete days; the gaps are days a cohort member did not report.`
    )
  }
  return { start: days[0], end: days.at(-1) ?? days[0], days, series, notes }
}

/**
 * An SVG path for one series, restarting at every gap so a missing day is a break
 * in the line and never a straight segment across it.
 */
export function trendPath(
  points: readonly TrendPoint[],
  x: (index: number) => number,
  y: (value: number) => number
): string {
  let path = ''
  let open = false
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false
      return
    }
    path += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(point.value).toFixed(1)} `
    open = true
  })
  return path.trim()
}

/** The plotted range across every series, or null when nothing was plotted. */
export function trendDomain(series: readonly TrendSeries[]): { min: number; max: number } | null {
  const values = series.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number => value !== null)
  )
  if (values.length === 0) {
    return null
  }
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  return min === max ? { min: min - 1, max: max + 1 } : { min, max }
}
