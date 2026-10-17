import { describe, expect, it } from 'vitest'
import { divisionHeadline, divisionStats } from './division-stats'
import { divisionKind, divisionLabel } from '../../../../shared/company-identity'
import {
  scorecardDocument,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/**
 * A division card shows one figure, so a wrong figure here reads as a verdict on a whole
 * part of the company. These tests hold the four rules that suppress it, and — more
 * importantly — that a suppression always carries its reason. An unavailable source
 * reading as a quiet division is the failure this grid exists to avoid.
 */

const NOW = new Date('2026-09-12T16:05:00Z')
const ok = (name: string): Record<string, unknown> => ({ name, ok: true, error: null })
const broken = (name: string): Record<string, unknown> => ({ name, ok: false, error: 'timeout' })

function document(over: Record<string, unknown> = {}): ScorecardDocument {
  return scorecardDocument.parse({
    generated_at: '2026-09-12T16:00:00Z',
    timezone: 'America/New_York',
    today: '2026-09-12',
    companies: [
      {
        slug: 'omnirogue',
        name: 'OmniRogue',
        today: {
          date: '2026-09-12',
          reported: ['revenue', 'ad_spend', 'pnl'],
          revenue: 1000,
          ad_spend: 300,
          pnl: 700
        },
        days: [],
        sources: [ok('meta:insights'), ok('stripe:primary')]
      }
    ],
    ads_accounts: [{ company: 'omnirogue', today: { cash_roas: 2.5 }, sources: [] }],
    finance: {
      omnirogue: {
        today: { reported: ['revenue', 'pnl'], revenue: 1000, pnl: 700, margin_pct: 70 }
      }
    },
    customer_service: {
      omnirogue: {
        today: { needs_human: 2 },
        backlog: { open_now: 4, needs_human_now: 2, oldest_open: null },
        people: [],
        recent_tickets: [],
        sources: [ok('freshdesk')]
      }
    },
    operations: {
      omnirogue: {
        tasks: {
          by_status: {},
          by_domain: [
            { name: 'Sales', live: 3, in_progress: 1, blocked: 0 },
            {
              name: 'Customer Service [co_2302606a8a46474e8311]',
              live: 2,
              in_progress: 0,
              blocked: 1
            },
            { name: 'Finance/Admin', live: 1, in_progress: 0, blocked: 0 },
            { name: 'Development', live: 5, in_progress: 2, blocked: 0 },
            { name: 'Operations', live: 4, in_progress: 0, blocked: 0 },
            { name: 'Curriculum', live: 1, in_progress: 0, blocked: 0 }
          ],
          blocked_reasons: []
        },
        github: [{ repo: 'a', open_prs: 7, merged_7d: 3, open_issues: 1, commits_7d: 20 }],
        sources: [ok('github:a')]
      }
    },
    ...over
  })
}

const headline = (name: string, doc = document()): ReturnType<typeof divisionHeadline> =>
  divisionHeadline(doc, 'omnirogue', name, NOW)

describe('each division gets the figure it owns', () => {
  it('gives Sales its spend and its cash comparison', () => {
    expect(headline('Sales').primary).toBe('$300.00 spent today')
    expect(headline('Sales').secondary).toBe('cash ROAS 2.50×')
  })

  it('gives Customer Service its backlog and who needs a person', () => {
    const row = headline('Customer Service')
    expect(row.primary).toBe('4 open tickets')
    expect(row.secondary).toBe('2 need a human')
  })

  it('gives Finance its P&L and its margin', () => {
    expect(headline('Finance/Admin').primary).toBe('$700.00 P&L today')
    expect(headline('Finance/Admin').secondary).toBe('70% margin')
  })

  it('gives Development its pull requests', () => {
    expect(headline('Development').primary).toBe('7 open pull requests')
    expect(headline('Development').secondary).toBe('3 merged in 7d')
  })

  it('gives Operations none, because its figures are company-wide', () => {
    // A company number on a department card would make every other card look quiet.
    const row = headline('Operations')
    expect(row.primary).toBeNull()
    expect(row.withheld).toBeNull()
  })

  it('gives an unknown department none rather than guessing one', () => {
    expect(headline('Curriculum').primary).toBeNull()
    expect(headline('Something nobody styled').primary).toBeNull()
  })

  it('reads a real hub name with its company-id tail', () => {
    // The hub appends [co_…]; without stripping it this resolved to generic, so the
    // department carried no headline and wore a neutral mark in the sidebar too.
    expect(divisionKind('Customer Service [co_2302606a8a46474e8311]')).toBe('customer-service')
    expect(divisionLabel('Customer Service [co_2302606a8a46474e8311]')).toBe('Customer Service')
    expect(headline('Customer Service [co_2302606a8a46474e8311]').primary).toBe('4 open tickets')
  })
})

describe('a suppressed figure always says why', () => {
  it('suppresses every headline once the document is past its freshness budget', () => {
    const stale = document({ stale_s: 3600 })
    for (const name of ['Sales', 'Customer Service', 'Finance/Admin', 'Development']) {
      const row = divisionHeadline(stale, 'omnirogue', name, NOW)
      expect(row.primary, name).toBeNull()
      expect(row.withheld, name).toContain('minutes old')
    }
  })

  it('suppresses Sales when the ad platform did not answer', () => {
    const doc = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['ad_spend'], ad_spend: 300 },
          days: [],
          sources: [broken('meta:insights')]
        }
      ]
    })
    const row = divisionHeadline(doc, 'omnirogue', 'Sales', NOW)
    expect(row.primary).toBeNull()
    expect(row.withheld).toContain('meta:insights')
  })

  it('keeps the Sales spend but drops its cash comparison when Stripe failed', () => {
    const doc = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['ad_spend'], ad_spend: 300 },
          days: [],
          sources: [ok('meta:insights'), broken('stripe:primary')]
        }
      ]
    })
    const row = divisionHeadline(doc, 'omnirogue', 'Sales', NOW)
    // Two facts, two dependencies: the spend survives, the comparison does not.
    expect(row.primary).toBe('$300.00 spent today')
    expect(row.secondary).toBeNull()
  })

  it('drops the cash comparison when Stripe truncated the day', () => {
    const doc = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: {
            date: '2026-09-12',
            reported: ['ad_spend'],
            ad_spend: 300,
            stripe_truncated: true
          },
          days: [],
          sources: [ok('meta:insights'), ok('stripe:primary')]
        }
      ]
    })
    expect(divisionHeadline(doc, 'omnirogue', 'Sales', NOW).secondary).toBeNull()
  })

  it('suppresses Sales when ad spend was not among the reported fields', () => {
    const doc = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['revenue'], revenue: 1, ad_spend: 0 },
          days: [],
          sources: [ok('meta:insights')]
        }
      ]
    })
    const row = divisionHeadline(doc, 'omnirogue', 'Sales', NOW)
    // A zero the collector did not vouch for is not a quiet day.
    expect(row.primary).toBeNull()
    expect(row.withheld).toContain('not reported')
  })

  it('suppresses Finance when ANY money source failed, not just one family', () => {
    const doc = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['pnl'], pnl: 700 },
          days: [],
          sources: [ok('meta:insights'), broken('stripe:primary')]
        }
      ]
    })
    // A P&L folds every source, so one failure is enough.
    const row = divisionHeadline(doc, 'omnirogue', 'Finance/Admin', NOW)
    expect(row.primary).toBeNull()
    expect(row.withheld).toContain('stripe:primary')
  })

  it('suppresses Development when one repository reported nothing', () => {
    const doc = document({
      operations: {
        omnirogue: {
          tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
          github: [
            { repo: 'a', open_prs: 7, merged_7d: 3 },
            { repo: 'b', open_prs: null, merged_7d: 2 }
          ],
          sources: [ok('github:a'), ok('github:b')]
        }
      }
    })
    const row = divisionHeadline(doc, 'omnirogue', 'Development', NOW)
    expect(row.primary).toBeNull()
    expect(row.withheld).toContain('not a total')
  })

  it('suppresses Development when no repository is tracked', () => {
    const doc = document({
      operations: {
        omnirogue: {
          tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
          github: [],
          sources: [ok('github:a')]
        }
      }
    })
    expect(divisionHeadline(doc, 'omnirogue', 'Development', NOW).withheld).toContain(
      'No repository'
    )
  })

  it('says a company has no desk rather than showing it as quiet', () => {
    const doc = document({ customer_service: {} })
    const row = divisionHeadline(doc, 'omnirogue', 'Customer Service', NOW)
    expect(row.primary).toBeNull()
    expect(row.withheld).toContain('no support desk')
  })
})

describe('the grid as a whole', () => {
  it('lists every division the collector split work by, with its own counts', () => {
    const rows = divisionStats(document(), 'omnirogue', NOW)
    expect(rows.map((row) => row.name)).toEqual([
      'Sales',
      'Customer Service',
      'Finance/Admin',
      'Development',
      'Operations',
      'Curriculum'
    ])
    // Counts come from the division's own rows, so a card cannot disagree with its page.
    const service = rows.find((row) => row.kind === 'customer-service')
    expect(service?.live).toBe(2)
    expect(service?.blocked).toBe(1)
  })

  it('is empty, not invented, when the collector split nothing', () => {
    expect(divisionStats(document({ operations: {} }), 'omnirogue', NOW)).toEqual([])
    expect(divisionStats(null, 'omnirogue', NOW)).toEqual([])
  })
})
