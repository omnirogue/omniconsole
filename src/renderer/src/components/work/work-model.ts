import type { AgentPaneCard, AgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import {
  marginPct,
  type FinanceCompany,
  type ScorecardCompany,
  type ScorecardDay,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/**
 * The Work home's arithmetic-free projections. Money is shown only when the
 * collector vouched for it: an unreported field is "unknown", never zero, and
 * estate totals are absent when the relay pruned the document to a person's
 * companies (the relay refuses to recompute sums, and so does this file).
 */

export type MoneyField = 'revenue' | 'ad_spend' | 'api_cost' | 'pnl'
export const MONEY_FIELDS: readonly MoneyField[] = ['revenue', 'ad_spend', 'api_cost', 'pnl']

export type Money =
  | { kind: 'value'; value: number }
  | { kind: 'unknown'; reason: 'unreported' | 'not-applicable' | 'missing' }

type MoneyDay = Pick<
  ScorecardDay,
  'reported' | 'revenue' | 'ad_spend' | 'api_cost' | 'pnl' | 'stripe_truncated'
> & {
  api_cost_available?: boolean
}

/** A figure the collector reported; anything else stays unknown. */
export function moneyOf(day: MoneyDay | null | undefined, field: MoneyField): Money {
  if (!day) {
    return { kind: 'unknown', reason: 'missing' }
  }
  if (field === 'api_cost' && day.api_cost_available === false) {
    return { kind: 'unknown', reason: 'not-applicable' }
  }
  // Why: newer documents name the fields the source answered; a legacy zero default is not a report.
  if (day.reported !== undefined && !day.reported.includes(field)) {
    return { kind: 'unknown', reason: 'unreported' }
  }
  // A truncated Stripe page undercounts revenue, and P&L with it. This is the third
  // place the rule has to hold: the finance window and the day row already check it,
  // and this reader — the one behind the Work home's company table — did not, so the
  // same truncated day showed as a verified figure here and as unknown beside it.
  if (day.stripe_truncated === true && (field === 'revenue' || field === 'pnl')) {
    return { kind: 'unknown', reason: 'missing' }
  }
  const value = day[field]
  return typeof value === 'number'
    ? { kind: 'value', value }
    : { kind: 'unknown', reason: 'missing' }
}

/** Today's API cost: the cost-analytics breakdown when the collector supplied one, else the day figure. */
export function apiCostToday(
  company: ScorecardCompany,
  finance: FinanceCompany | undefined
): Money {
  const total = finance?.api_cost_today?.total
  if (typeof total === 'number') {
    return { kind: 'value', value: total }
  }
  return moneyOf(company.today, 'api_cost')
}

export function apiCostSevenDays(finance: FinanceCompany | undefined): Money {
  const total = finance?.api_cost_7d?.total
  return typeof total === 'number'
    ? { kind: 'value', value: total }
    : { kind: 'unknown', reason: 'missing' }
}

export type CompanyMoneyRow = {
  slug: string
  name: string
  today: Record<MoneyField, Money>
  apiCostSevenDays: Money
  marginPct: number | null
}

export function companyMoneyRows(document: ScorecardDocument): CompanyMoneyRow[] {
  return document.companies.map((company) => {
    const finance = document.finance?.[company.slug]
    return {
      slug: company.slug,
      name: company.name ?? company.slug,
      today: {
        revenue: moneyOf(company.today, 'revenue'),
        ad_spend: moneyOf(company.today, 'ad_spend'),
        api_cost: apiCostToday(company, finance),
        pnl: moneyOf(company.today, 'pnl')
      },
      apiCostSevenDays: apiCostSevenDays(finance),
      // Why not `finance.today.margin_pct` directly: a supplied margin is only a
      // measurement when the source also vouched for the revenue and P&L behind it.
      // Reading it raw here was the same defect a review found in the finance tiles,
      // surviving in a sibling — which is how an incomplete fix looks.
      marginPct: marginPct(finance?.today)
    }
  })
}

/** The estate's day, or null when the relay omitted the totals for this reader. */
export function portfolioToday(document: ScorecardDocument): Record<MoneyField, Money> | null {
  if (document.scope?.totals_omitted || !document.totals?.today) {
    return null
  }
  const day = document.totals.today
  return {
    revenue: moneyOf(day, 'revenue'),
    ad_spend: moneyOf(day, 'ad_spend'),
    api_cost: moneyOf(day, 'api_cost'),
    pnl: moneyOf(day, 'pnl')
  }
}

export function formatMoney(value: number, options: { signed?: boolean } = {}): string {
  const magnitude = Math.abs(value)
  const text = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: magnitude >= 100 ? 0 : 2
  }).format(magnitude)
  if (value < 0) {
    return `−${text}`
  }
  return options.signed && value > 0 ? `+${text}` : text
}

/** How old the scorecard is, in whole minutes, from the relay's staleness or its generation time. */
export function scorecardAgeMinutes(document: ScorecardDocument, now: Date): number | null {
  if (typeof document.stale_s === 'number' && Number.isFinite(document.stale_s)) {
    return Math.max(0, Math.round(document.stale_s / 60))
  }
  const generated = Date.parse(document.generated_at)
  return Number.isFinite(generated)
    ? Math.max(0, Math.round((now.getTime() - generated) / 60_000))
    : null
}

export type SessionActivityState = 'needs-you' | 'working' | 'waiting' | 'finished' | 'idle'

export type SessionActivity = {
  session: SidebarSession
  card: AgentPaneCard | null
  state: SessionActivityState
  /** When a waiting session returns, as the store recorded it. */
  until: string | null
}

const STATE_ORDER: Record<SessionActivityState, number> = {
  'needs-you': 0,
  working: 1,
  waiting: 2,
  finished: 3,
  idle: 4
}

/**
 * Every open session with what it is doing now. A per-device wait wins over the
 * pane's own state: the person asked not to see it, and nothing underneath changed.
 * With the "needs you" list given, a pursued run's panes read through it: a stopped or idle
 * worker is nobody's question, and the run's open request marks the conversation that owns it.
 */
export function sessionActivities(
  sessions: readonly SidebarSession[],
  snapshot: Pick<AgentPaneSnapshot, 'cardsByPaneKey'> &
    Partial<Pick<AgentPaneSnapshot, 'attention'>>,
  waiting: ReadonlySet<string>,
  until: Readonly<Record<string, string>>,
  finished: ReadonlyMap<string, number>
): SessionActivity[] {
  const rows: SessionActivity[] = []
  const listed = snapshot.attention ? new Set(snapshot.attention.map((pane) => pane.paneKey)) : null
  const asking = new Set(
    (snapshot.attention ?? []).flatMap((pane) => (pane.run ? [pane.run.sourceRowKey] : []))
  )
  for (const session of sessions) {
    const card = session.paneKey ? (snapshot.cardsByPaneKey.get(session.paneKey) ?? null) : null
    const waitKey = session.paneKey ? waitLaterKeyForPane(session.paneKey) : null
    // Why the mark: a pane called finished left the list by the person's hand, not by a run's.
    const ownPrompt =
      card?.bucket === 'attention' &&
      (!listed || listed.has(card.paneKey) || (waitKey !== null && finished.has(waitKey)))
    let state: SessionActivityState = 'idle'
    if (waitKey && waiting.has(waitKey)) {
      state = 'waiting'
    } else if (ownPrompt || asking.has(session.rowKey)) {
      state = 'needs-you'
    } else if (card?.bucket === 'working') {
      state = 'working'
    } else if (card?.bucket === 'done' || (waitKey !== null && finished.has(waitKey))) {
      state = 'finished'
    }
    rows.push({ session, card, state, until: waitKey ? (until[waitKey] ?? null) : null })
  }
  return rows.sort((left, right) => {
    const rank = STATE_ORDER[left.state] - STATE_ORDER[right.state]
    if (rank !== 0) {
      return rank
    }
    const age = (right.card?.stateChangedAt ?? 0) - (left.card?.stateChangedAt ?? 0)
    return age !== 0 ? age : left.session.label.localeCompare(right.session.label)
  })
}

export function countByState(
  rows: readonly SessionActivity[]
): Record<SessionActivityState, number> {
  const counts: Record<SessionActivityState, number> = {
    'needs-you': 0,
    working: 0,
    waiting: 0,
    finished: 0,
    idle: 0
  }
  for (const row of rows) {
    counts[row.state] += 1
  }
  return counts
}
