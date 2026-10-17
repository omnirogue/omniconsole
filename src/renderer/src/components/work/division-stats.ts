import {
  divisionKind,
  divisionLabel,
  divisionOwnsHeadline,
  type DivisionKind
} from '../../../../shared/company-identity'
import {
  everySourceHealthy,
  failedSources,
  marginPct,
  repoTotal,
  reportedAmount,
  SCORECARD_STALE_MINUTES,
  sourcesWithPrefix,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'
import { statNumber as number } from './stats-model'

/**
 * One headline per division, and the rules that decide when there is none.
 *
 * A division card answers "how is this part of the company doing" in one figure, which
 * means a wrong figure here is read as a verdict. Four rules therefore suppress it, and
 * every suppression says why:
 *
 *  1. **Stale document, no headline anywhere.** Past the freshness budget the figures
 *     describe a state of the world that has moved on, and a division card has no room
 *     to qualify itself.
 *  2. **The sources that feed THIS figure must all be healthy.** Sales needs the ad
 *     platform; its cash comparison additionally needs Stripe; finance needs every
 *     source, because a P&L is a fold of all of them; development needs the code host.
 *     A figure computed over a failed source is not a smaller figure, it is a wrong one.
 *  3. **A total missing one contributor is no total.** One repository reporting nothing
 *     makes the pull-request count unknown rather than a lower bound in a total's place.
 *  4. **Operations never gets one**, because the collector's operations block is
 *     company-wide and would put the company's number on a division's card.
 *
 * A suppressed headline always travels with its reason, so an unavailable source can
 * never read as a quiet division.
 */

export type DivisionHeadline = {
  /** The figure a person reads first. Null when suppressed. */
  primary: string | null
  /** The figure beside it, when this kind has one and it survived. */
  secondary: string | null
  /** Why there is no primary, in the collector's own terms. */
  withheld: string | null
}

export type DivisionStat = {
  key: string
  name: string
  kind: DivisionKind
  /** Work counted from the division's own rows, so a click never disagrees with the card. */
  live: number | null
  inProgress: number | null
  blocked: number | null
  headline: DivisionHeadline
}

const NO_HEADLINE: DivisionHeadline = { primary: null, secondary: null, withheld: null }

const usd = (value: number | null): string | null =>
  value === null
    ? null
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2
      }).format(value)

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/** Minutes since the document was written, from the relay's staleness or its own stamp. */
export function documentAgeMinutes(
  document: ScorecardDocument,
  now: Date = new Date()
): number | null {
  if (typeof document.stale_s === 'number' && Number.isFinite(document.stale_s)) {
    return Math.max(0, Math.round(document.stale_s / 60))
  }
  const generated = Date.parse(document.generated_at)
  return Number.isFinite(generated)
    ? Math.max(0, Math.round((now.getTime() - generated) / 60_000))
    : null
}

function salesHeadline(document: ScorecardDocument, slug: string): DivisionHeadline {
  const company = document.companies.find((row) => row.slug === slug)
  const metaSources = sourcesWithPrefix(company?.sources, 'meta:')
  if (!everySourceHealthy(metaSources)) {
    return {
      primary: null,
      secondary: null,
      withheld:
        metaSources.length === 0
          ? 'No ad-platform source reported for this company.'
          : `The ad platform did not answer: ${failedSources(metaSources).join(', ')}.`
    }
  }
  // The collector says explicitly when it could not read spend; a zero then is not a zero.
  const today = company?.today
  if (today?.reported !== undefined && !today.reported.includes('ad_spend')) {
    return { primary: null, secondary: null, withheld: 'Ad spend was not reported today.' }
  }
  const spend = number(today?.ad_spend)
  const account = document.ads_accounts.find((row) => row.company === slug)
  // The cash comparison is a second fact with a second dependency: Stripe.
  const stripeSources = sourcesWithPrefix(company?.sources, 'stripe:')
  const cashUsable = everySourceHealthy(stripeSources) && today?.stripe_truncated !== true
  const roas = cashUsable ? number(account?.today?.cash_roas) : null
  return {
    primary: spend === null ? null : `${usd(spend)} spent today`,
    secondary: roas === null ? null : `cash ROAS ${roas.toFixed(2)}×`,
    withheld: spend === null ? 'Ad spend was not reported today.' : null
  }
}

function serviceHeadline(document: ScorecardDocument, slug: string): DivisionHeadline {
  const service = document.customer_service?.[slug]
  if (!service) {
    return {
      primary: null,
      secondary: null,
      withheld: 'This company has no support desk this console can read.'
    }
  }
  const failed = failedSources(service.sources)
  if (failed.length > 0) {
    return {
      primary: null,
      secondary: null,
      withheld: `The desk did not answer: ${failed.join(', ')}.`
    }
  }
  const open = number(service.backlog?.open_now)
  const needsHuman = number(service.backlog?.needs_human_now) ?? number(service.today?.needs_human)
  return {
    primary: open === null ? null : plural(open, 'open ticket', 'open tickets'),
    secondary:
      needsHuman === null
        ? null
        : `${needsHuman.toLocaleString('en-US')} need${needsHuman === 1 ? 's' : ''} a human`,
    withheld: open === null ? 'The desk reported no backlog count.' : null
  }
}

function financeHeadline(document: ScorecardDocument, slug: string): DivisionHeadline {
  const company = document.companies.find((row) => row.slug === slug)
  // A P&L folds every source, so it needs every source — no prefix narrows this one.
  if (!everySourceHealthy(company?.sources)) {
    const failed = failedSources(company?.sources)
    return {
      primary: null,
      secondary: null,
      withheld:
        failed.length > 0
          ? `A money source did not answer: ${failed.join(', ')}.`
          : 'No money source reported for this company.'
    }
  }
  const finance = document.finance?.[slug]
  const pnl = reportedAmount(finance?.today, 'pnl') ?? number(company?.today?.pnl)
  const margin = marginPct(finance?.today)
  return {
    primary: pnl === null ? null : `${usd(pnl)} P&L today`,
    secondary: margin === null ? null : `${margin.toFixed(margin % 1 === 0 ? 0 : 1)}% margin`,
    withheld: pnl === null ? 'Reported P&L is unavailable for today.' : null
  }
}

function developmentHeadline(document: ScorecardDocument, slug: string): DivisionHeadline {
  const operations = document.operations?.[slug]
  const githubSources = sourcesWithPrefix(operations?.sources, 'github:')
  if (!everySourceHealthy(githubSources)) {
    return {
      primary: null,
      secondary: null,
      withheld:
        githubSources.length === 0
          ? 'No code host reported for this company.'
          : `The code host did not answer: ${failedSources(githubSources).join(', ')}.`
    }
  }
  const repos = operations?.github ?? []
  if (repos.length === 0) {
    return {
      primary: null,
      secondary: null,
      withheld: 'No repository is tracked for this company.'
    }
  }
  // One repo reporting nothing makes the total unknown, not a lower bound.
  const open = repoTotal(repos, 'open_prs')
  const merged = repoTotal(repos, 'merged_7d')
  return {
    primary: open === null ? null : plural(open, 'open pull request', 'open pull requests'),
    secondary: merged === null ? null : `${merged.toLocaleString('en-US')} merged in 7d`,
    withheld: open === null ? 'A repository reported nothing, so the total is not a total.' : null
  }
}

/** The headline for one division of one company, or none, with its reason. */
export function divisionHeadline(
  document: ScorecardDocument | null | undefined,
  slug: string,
  divisionName: string,
  now: Date = new Date()
): DivisionHeadline {
  if (!document) {
    return NO_HEADLINE
  }
  const age = documentAgeMinutes(document, now)
  if (age !== null && age > SCORECARD_STALE_MINUTES) {
    return {
      primary: null,
      secondary: null,
      withheld: `These figures are ${age} minutes old, past the ${SCORECARD_STALE_MINUTES}-minute budget.`
    }
  }
  const kind = divisionKind(divisionName)
  if (!divisionOwnsHeadline(kind)) {
    return NO_HEADLINE
  }
  // Exhaustive on purpose: a new department kind must be given a headline or explicitly
  // denied one here, rather than silently falling through to none.
  switch (kind) {
    case 'sales':
      return salesHeadline(document, slug)
    case 'customer-service':
      return serviceHeadline(document, slug)
    case 'finance':
      return financeHeadline(document, slug)
    case 'development':
      return developmentHeadline(document, slug)
    // These own no headline: operations because its figures are company-wide, the rest
    // because the collector publishes no per-department figure for them.
    case 'operations':
    case 'creative':
    case 'prototypes':
    case 'marketing':
    case 'product':
    case 'generic':
      return NO_HEADLINE
  }
}

/**
 * Every division of one company, with its own work counts and its headline. Counts come
 * from the division's own rows so the card can never disagree with the page a click
 * lands on.
 */
export function divisionStats(
  document: ScorecardDocument | null | undefined,
  slug: string,
  now: Date = new Date()
): DivisionStat[] {
  const rows = document?.operations?.[slug]?.tasks?.by_domain ?? []
  return rows.map((row) => ({
    key: `${slug}/${row.name}`,
    name: divisionLabel(row.name),
    kind: divisionKind(row.name),
    live: number(row.live),
    inProgress: number(row.in_progress),
    blocked: number(row.blocked),
    headline: divisionHeadline(document, slug, row.name, now)
  }))
}
