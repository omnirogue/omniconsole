import {
  confirmedFullCompletion,
  unitCost,
  type SalesAdsReport,
  type WebinarSummary
} from '../../../../shared/console-advertising-contract'

export type MatchedWebinarAdSet = {
  id: string
  name: string
  spend: number
  registrations: number
  attended: number
  full: number | null
  costPerRegistration: number | null
  costPerAttendee: number | null
  costPerFull: number | null
}

export type WebinarSpendMatch = {
  rows: MatchedWebinarAdSet[]
  unmatchedRegistrations: number
  withheld: string | null
}

function dateInZone(instant: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(instant))
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  } catch {
    return null
  }
}

function timeInZone(instant: string, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(instant))
  } catch {
    return null
  }
}

function unavailable(reason: string): WebinarSpendMatch {
  return { rows: [], unmatchedRegistrations: 0, withheld: reason }
}

/** Only a fresh, same-calendar, same-ID cohort is allowed to grow a cost figure. */
export function matchTodayWebinarSpend(
  report: SalesAdsReport | null,
  summary: WebinarSummary | null
): WebinarSpendMatch {
  if (!report || !summary || summary.window !== 'today') {
    return unavailable('Today’s Meta ad-set and WebinarJam reports are both required.')
  }
  if (report.company !== 'omnirogue' || summary.company !== 'omnirogue') {
    return unavailable('The reports do not cover the same company.')
  }
  if (report.currency !== 'USD' || report.partial || report.sources.some((source) => !source.ok)) {
    return unavailable('Meta currency or source coverage is incomplete.')
  }
  const cohort = summary.cohort
  const start = Date.parse(cohort.start)
  const end = Date.parse(cohort.end)
  const metaObserved = Date.parse(report.measured_at ?? '')
  const webinarObserved = Date.parse(summary.as_of)
  if (
    cohort.basis !== 'signup_date' ||
    !cohort.includes_today ||
    report.timezone !== cohort.time_zone ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    report.date_start !== report.date_stop ||
    timeInZone(cohort.start, cohort.time_zone) !== '00:00:00' ||
    report.date_start !== dateInZone(cohort.start, cohort.time_zone) ||
    report.date_stop !== dateInZone(new Date(end - 1).toISOString(), cohort.time_zone)
  ) {
    return unavailable('The signup and spend dates or timezones do not match exactly.')
  }
  if (
    !Number.isFinite(metaObserved) ||
    !Number.isFinite(webinarObserved) ||
    Math.abs(metaObserved - webinarObserved) > 15 * 60_000
  ) {
    return unavailable('The two sources were observed more than 15 minutes apart.')
  }
  const enterprise = report.rows.filter(
    (row) => row.level === 'adset' && row.segment === 'enterprise'
  )
  const meta = new Map(enterprise.map((row) => [row.platform_id, row]))
  const webinar = new Map(summary.by_adset.map((row) => [row.id, row]))
  if (meta.size !== enterprise.length || webinar.size !== summary.by_adset.length) {
    return unavailable('An ad-set ID was duplicated in one of the reports.')
  }
  if (
    summary.by_adset.reduce((total, row) => total + row.registrations, 0) !==
    summary.attribution.adset_mapped_registrations
  ) {
    return unavailable('WebinarJam’s ad-set attribution counts do not reconcile.')
  }
  const rows: MatchedWebinarAdSet[] = []
  for (const group of summary.by_adset) {
    const adSet = meta.get(group.id)
    if (adSet?.spend == null) {
      continue
    }
    const full = confirmedFullCompletion(group)
    rows.push({
      id: group.id,
      name: group.name ?? adSet.name,
      spend: adSet.spend,
      registrations: group.registrations,
      attended: group.attended,
      full,
      costPerRegistration: unitCost(adSet.spend, group.registrations),
      costPerAttendee: unitCost(adSet.spend, group.attended),
      costPerFull: unitCost(adSet.spend, full)
    })
  }
  return {
    rows: rows.sort((left, right) => right.spend - left.spend),
    unmatchedRegistrations: Math.max(
      0,
      summary.metrics.registrations - rows.reduce((total, row) => total + row.registrations, 0)
    ),
    withheld: rows.length === 0 ? 'No webinar ad-set ID matched measured Enterprise spend.' : null
  }
}
