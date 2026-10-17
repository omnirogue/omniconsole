import { describe, expect, it } from 'vitest'
import { completeDays, financialHistory, trendDomain, trendPath } from './financial-history'
import { financeAmount, financeStats } from './finance-stats'
import { operationsStats } from './operations-stats'
import { serviceStats } from './service-stats'
import { coverageNotes, costDimensionNote, costRows } from './stats-model'
import { statText } from './StatTile'
import {
  scorecardDocument,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

function parse(over: Record<string, unknown> = {}): ScorecardDocument {
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
          reported: ['revenue', 'ad_spend', 'api_cost', 'pnl'],
          revenue: 1000,
          ad_spend: 300,
          api_cost: 50,
          pnl: 650,
          api_cost_available: true,
          new_cash: 800,
          new_customers: 4,
          rebill_cash: 200,
          rebills: 3
        },
        days: [],
        sources: []
      }
    ],
    ...over
  })
}

describe('finance stats', () => {
  it('reads a field the source reported and withholds one it did not', () => {
    expect(financeAmount({ reported: ['revenue'], revenue: 10, pnl: 0 } as never, 'revenue')).toBe(
      10
    )
    // A legacy zero where the source answered nothing is not a measurement.
    expect(financeAmount({ reported: ['revenue'], revenue: 10, pnl: 0 } as never, 'pnl')).toBeNull()
  })

  it('withholds revenue and P&L when the Stripe page was truncated, but not ad spend', () => {
    const window = {
      reported: ['revenue', 'ad_spend', 'pnl'],
      stripe_truncated: true,
      revenue: 10,
      ad_spend: 5,
      pnl: 5
    } as never
    expect(financeAmount(window, 'revenue')).toBeNull()
    expect(financeAmount(window, 'pnl')).toBeNull()
    expect(financeAmount(window, 'ad_spend')).toBe(5)
  })

  it('omits the API-cost tiles entirely for a company that bills no tenant', () => {
    const document = parse({
      companies: [
        {
          slug: 'apexlabs',
          name: 'ApexLabs',
          today: {
            date: '2026-09-12',
            reported: ['revenue'],
            revenue: 0,
            api_cost_available: false
          },
          days: [],
          sources: []
        }
      ]
    })
    const ids = financeStats(document.companies[0], undefined).map((stat) => stat.id)
    // Not zero, not an em dash: absent, because a $0.00 would read as a measurement.
    expect(ids).not.toContain('api_cost')
    expect(ids).not.toContain('api_cost_7d')
    expect(ids).toContain('revenue')
  })

  it('keeps the API-cost tiles for a company that does bill one', () => {
    const ids = financeStats(parse().companies[0], undefined).map((stat) => stat.id)
    expect(ids).toContain('api_cost')
    expect(ids).toContain('api_cost_7d')
  })

  it('names the revenue split the company actually reports', () => {
    const stats = financeStats(parse().companies[0], undefined)
    expect(stats[0].caption).toContain('new $800')
    expect(stats[0].caption).toContain('rebills $200')
  })

  it('uses the gateway split for a company that reports one', () => {
    const document = parse({
      companies: [
        {
          slug: 'acme',
          name: 'ACME',
          today: {
            date: '2026-09-12',
            reported: ['revenue'],
            revenue: 500,
            gatewayone_cash: 400,
            stripe_direct_cash: 100
          },
          days: [],
          sources: []
        }
      ]
    })
    expect(financeStats(document.companies[0], undefined)[0].caption).toContain('GatewayOne $400')
  })

  it('withholds a margin over no revenue and explains a partial window', () => {
    const finance = {
      today: {
        reported: ['revenue', 'pnl'],
        revenue: 0,
        pnl: -5,
        margin_pct: null,
        financial_quality: { pnl: { state: 'partial', observed: 3, expected: 7 } }
      }
    } as never
    const margin = financeStats(parse().companies[0], finance).find(
      (stat) => stat.id === 'margin_today'
    )
    expect(margin?.value).toBeNull()
    expect(margin?.withheld).toContain('3 of 7 days')
  })

  it('tones a thin margin as a warning and a loss as bad', () => {
    const thin = financeStats(parse().companies[0], {
      today: { reported: ['revenue', 'pnl'], revenue: 100, pnl: 5, margin_pct: 5 }
    } as never).find((stat) => stat.id === 'margin_today')
    expect(thin?.tone).toBe('warn')
    const loss = financeStats(parse().companies[0], {
      today: { reported: ['revenue', 'pnl'], revenue: 100, pnl: -5, margin_pct: -5 }
    } as never).find((stat) => stat.id === 'margin_today')
    expect(loss?.tone).toBe('bad')
  })
})

describe('API cost breakdown', () => {
  it('tells a dimension that was never sent apart from one that found nothing', () => {
    expect(costRows({ total: 10, by_provider: null } as never, 'by_provider')).toBeNull()
    expect(costRows({ total: 10, by_provider: [] } as never, 'by_provider')).toEqual([])
  })

  it('sorts rows by cost, largest first', () => {
    const rows = costRows(
      {
        total: 10,
        by_model: [
          { name: 'small', cost: 1, requests: 9 },
          { name: 'large', cost: 8, requests: 2 }
        ]
      } as never,
      'by_model'
    )
    expect(rows?.map((row) => row.name)).toEqual(['large', 'small'])
  })

  it('says how much of a truncated dimension it is showing', () => {
    const note = costDimensionNote(
      {
        total: 10,
        by_agent: [],
        dimension_quality: { by_agent: { state: 'partial', returned: 12, supplied: 30 } }
      } as never,
      'by_agent'
    )
    expect(note).toBe('Partial dimension: 12 of 30 supplied rows.')
  })
})

describe('customer service stats', () => {
  const service = {
    today: { created: 10, replied: 6, spam: 1, needs_human: 2 },
    week: { created: 60, replied: 50 },
    backlog: { open_now: 4, needs_human_now: 2, oldest_open: '2026-09-01T00:00:00Z' },
    detail: { replied_7d: 50, response_hours_avg: 0.5, response_hours_median: 0.25 },
    sentiment: { method: 'triage category scan', window_days: 7, sample: 40, negative_pct: 45 },
    people: [],
    recent_tickets: []
  } as never

  it('derives unanswered from created less replied and spam, never below zero', () => {
    const stats = serviceStats(service)
    expect(stats.find((stat) => stat.id === 'unanswered')?.value).toBe(3)
    const negative = serviceStats({
      today: { created: 1, replied: 5, spam: 0 },
      people: [],
      recent_tickets: []
    } as never)
    expect(negative.find((stat) => stat.id === 'unanswered')?.value).toBe(0)
  })

  it('leaves unanswered unknown when one of its three inputs was not counted', () => {
    const stats = serviceStats({
      today: { created: 10, replied: 6 },
      people: [],
      recent_tickets: []
    } as never)
    expect(stats.find((stat) => stat.id === 'unanswered')?.value).toBeNull()
  })

  it('warns at or above two fifths negative', () => {
    expect(serviceStats(service).find((stat) => stat.id === 'negative')?.tone).toBe('warn')
  })

  it('withholds sentiment with no sample rather than showing nought per cent', () => {
    const stats = serviceStats({ today: {}, people: [], recent_tickets: [] } as never)
    const negative = stats.find((stat) => stat.id === 'negative')
    expect(negative?.value).toBeNull()
    expect(negative?.withheld).toBeTruthy()
  })
})

describe('operations stats', () => {
  it('refuses a pull-request total when one repository reported nothing', () => {
    const stats = operationsStats({
      tasks: { by_status: {}, live: 5, blocked: 1, by_domain: [], blocked_reasons: [] },
      github: [
        {
          repo: 'a',
          open_prs: 3,
          merged_7d: 1,
          open_issues: 0,
          commits_7d: 10,
          open_pr_list: [],
          merged_list: []
        },
        {
          repo: 'b',
          open_prs: null,
          merged_7d: 2,
          open_issues: 1,
          commits_7d: 5,
          open_pr_list: [],
          merged_list: []
        }
      ],
      waiting_on_human: [],
      waiting_on_ai: [],
      recently_done: [],
      top_live: [],
      sessions_working: []
    } as never)
    const open = stats.find((stat) => stat.id === 'open_prs')
    expect(open?.value).toBeNull()
    expect(open?.withheld).toContain('not a total')
    // A field every repo answered still totals.
    expect(stats.find((stat) => stat.id === 'merged_7d')?.value).toBe(3)
  })

  it('says a count is a floor when the collector sent no whole count', () => {
    const stats = operationsStats({
      tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
      github: [],
      waiting_on_human: [{ id: 'a', title: 'x' }],
      waiting_on_ai: [],
      recently_done: [],
      top_live: [],
      sessions_working: []
    } as never)
    const waiting = stats.find((stat) => stat.id === 'waiting_human')
    expect(waiting?.value).toBe(1)
    expect(waiting?.caption).toContain('capped')
  })
})

describe('financial history', () => {
  it('counts the seven days before the collector own today, not the viewer clock', () => {
    expect(completeDays('2026-09-12')).toEqual([
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11'
    ])
  })

  it('breaks a line on a day a cohort member did not report', () => {
    const document = parse({
      companies: [
        {
          slug: 'a',
          name: 'A',
          days: [
            { date: '2026-09-10', reported: ['revenue'], revenue: 10 },
            { date: '2026-09-11', reported: ['revenue'], revenue: 20 }
          ],
          sources: []
        },
        {
          slug: 'b',
          name: 'B',
          // B reported only the later day, so 09-10 has no estate total.
          days: [{ date: '2026-09-11', reported: ['revenue'], revenue: 5 }],
          sources: []
        }
      ]
    })
    const history = financialHistory(document)
    const revenue = history?.series.find((series) => series.metric === 'revenue')
    expect(revenue?.cohort).toEqual(['A', 'B'])
    const byDate = new Map(revenue?.points.map((point) => [point.date, point.value]))
    expect(byDate.get('2026-09-10')).toBeNull()
    expect(byDate.get('2026-09-11')).toBe(25)
    expect(revenue?.covered).toBe(1)
  })

  it('excludes a date a company reported twice and says so', () => {
    const document = parse({
      companies: [
        {
          slug: 'a',
          name: 'A',
          days: [
            { date: '2026-09-11', reported: ['revenue'], revenue: 10 },
            { date: '2026-09-11', reported: ['revenue'], revenue: 11 }
          ],
          sources: []
        }
      ]
    })
    const history = financialHistory(document)
    expect(history?.notes.some((note) => note.includes('more than once'))).toBe(true)
  })

  it('restarts the path at every gap so no segment crosses a missing day', () => {
    const path = trendPath(
      [
        { date: 'a', value: 1 },
        { date: 'b', value: null },
        { date: 'c', value: 3 }
      ],
      (index) => index * 10,
      (value) => value
    )
    expect(path.match(/M/g)).toHaveLength(2)
    expect(path).not.toContain('L20')
  })

  it('has no domain when nothing was plotted', () => {
    expect(
      trendDomain([{ metric: 'revenue', label: 'r', points: [], cohort: [], covered: 0 }])
    ).toBeNull()
  })
})

describe('figure formatting', () => {
  it('prints an em dash for a figure nobody read, never a zero', () => {
    expect(statText({ id: 'a', label: '', value: null, kind: 'money' })).toBe('—')
    expect(statText({ id: 'a', label: '', value: null, kind: 'percent' })).toBe('—')
    expect(statText({ id: 'a', label: '', value: null, kind: 'count' })).toBe('—')
  })

  it('gives a loss a real minus sign, not a hyphen', () => {
    expect(statText({ id: 'a', label: '', value: -1200, kind: 'money' })).toBe('−$1,200')
    expect(statText({ id: 'a', label: '', value: -5, kind: 'percent' })).toBe('−5%')
  })

  it('writes a sub-hour reply time in minutes', () => {
    expect(statText({ id: 'a', label: '', value: 0.5, kind: 'hours' })).toBe('30m')
    expect(statText({ id: 'a', label: '', value: 3.25, kind: 'hours' })).toBe('3.3h')
  })
})

describe('coverage notes', () => {
  it('names the failed source and the block it fed, per company', () => {
    const document = parse({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          days: [],
          sources: [{ name: 'stripe:primary', ok: false, error: 'timeout' }]
        }
      ],
      customer_service: {
        omnirogue: {
          people: [],
          recent_tickets: [],
          sources: [{ name: 'freshdesk', ok: false, error: 'unreachable' }]
        }
      }
    })
    const notes = coverageNotes(document)
    expect(notes.some((note) => note.detail.includes('stripe:primary'))).toBe(true)
    expect(
      notes.some(
        (note) => note.scope.includes('customer service') && note.detail.includes('freshdesk')
      )
    ).toBe(true)
  })

  it('reports nothing when every source answered', () => {
    expect(coverageNotes(parse())).toEqual([])
  })
})

describe('a fallback may not smuggle in a figure the window withheld', () => {
  // Each case below FAILED before the review: a `??` chain reached past the honesty
  // check to the raw day row, or a margin was divided from withheld operands.
  const truncated = parse({
    companies: [
      {
        slug: 'omnirogue',
        name: 'OmniRogue',
        today: {
          date: '2026-09-12',
          reported: ['revenue', 'ad_spend', 'pnl'],
          stripe_truncated: true,
          revenue: 1000,
          ad_spend: 300,
          pnl: 700,
          api_cost_available: true
        },
        days: [],
        sources: []
      }
    ]
  })

  it('withholds revenue from the day row when Stripe truncated it', () => {
    // No finance window at all, so the day row is the only source — and it is tainted.
    const revenue = financeStats(truncated.companies[0], undefined).find(
      (stat) => stat.id === 'revenue'
    )
    expect(revenue?.value).toBeNull()
  })

  it('still reads ad spend from that day, because its source was not truncated', () => {
    const spend = financeStats(truncated.companies[0], undefined).find(
      (stat) => stat.id === 'ad_spend'
    )
    expect(spend?.value).toBe(300)
  })

  it('withholds a day figure the source never reported', () => {
    const partial = parse({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          // `reported` names revenue only; the 300 beside ad_spend is a legacy default.
          today: { date: '2026-09-12', reported: ['revenue'], revenue: 10, ad_spend: 300 },
          days: [],
          sources: []
        }
      ]
    })
    const stats = financeStats(partial.companies[0], undefined)
    expect(stats.find((stat) => stat.id === 'revenue')?.value).toBe(10)
    expect(stats.find((stat) => stat.id === 'ad_spend')?.value).toBeNull()
  })

  it('withholds the API cost of a company that bills no tenant, even from the day row', () => {
    const none = parse({
      companies: [
        {
          slug: 'apexlabs',
          name: 'ApexLabs',
          today: {
            date: '2026-09-12',
            reported: ['revenue', 'api_cost'],
            revenue: 0,
            api_cost: 0,
            api_cost_available: false
          },
          days: [],
          sources: []
        }
      ]
    })
    const ids = financeStats(none.companies[0], undefined).map((stat) => stat.id)
    expect(ids).not.toContain('api_cost')
  })

  it('refuses a margin divided from a truncated revenue', () => {
    const margin = financeStats(truncated.companies[0], {
      today: {
        reported: ['revenue', 'pnl'],
        stripe_truncated: true,
        revenue: 1000,
        pnl: 700,
        margin_pct: 70
      }
    } as never).find((stat) => stat.id === 'margin_today')
    // The source supplied 70, but it also said the revenue behind it is incomplete.
    expect(margin?.value).toBeNull()
  })

  it('refuses a margin whose P&L the source did not report', () => {
    const margin = financeStats(truncated.companies[0], {
      today: { reported: ['revenue'], revenue: 1000, pnl: 700, margin_pct: 70 }
    } as never).find((stat) => stat.id === 'margin_today')
    expect(margin?.value).toBeNull()
  })

  it('still reports a margin the source fully vouched for', () => {
    const margin = financeStats(truncated.companies[0], {
      today: { reported: ['revenue', 'pnl'], revenue: 1000, pnl: 700, margin_pct: 70 }
    } as never).find((stat) => stat.id === 'margin_today')
    expect(margin?.value).toBe(70)
  })
})

describe('an absent list is not an empty one', () => {
  it('reports no count for a list the collector never sent', () => {
    const stats = operationsStats({
      tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
      github: []
    } as never)
    for (const id of ['waiting_human', 'waiting_ai', 'sessions']) {
      const stat = stats.find((entry) => entry.id === id)
      // Zero here would claim nobody is waiting, when nobody looked.
      expect(stat?.value, id).toBeNull()
    }
  })

  it('reports zero for a list it sent and found empty', () => {
    const stats = operationsStats({
      tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
      github: [],
      waiting_on_human: [],
      waiting_on_ai: [],
      sessions_working: []
    } as never)
    for (const id of ['waiting_human', 'waiting_ai', 'sessions']) {
      expect(stats.find((entry) => entry.id === id)?.value, id).toBe(0)
    }
  })

  it('calls a sent list a floor only when it has no whole count beside it', () => {
    const capped = operationsStats({
      tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
      github: [],
      waiting_on_human: [{ id: 'a', title: 'x' }]
    } as never).find((entry) => entry.id === 'waiting_human')
    expect(capped?.caption).toContain('capped')
    const counted = operationsStats({
      tasks: { by_status: {}, by_domain: [], blocked_reasons: [] },
      github: [],
      waiting_on_human: [{ id: 'a', title: 'x' }],
      waiting_on_human_count: 9
    } as never).find((entry) => entry.id === 'waiting_human')
    expect(counted?.value).toBe(9)
    expect(counted?.caption).toBeUndefined()
  })
})

describe('a tone must judge the figure actually shown', () => {
  it('warns on people needing a human even when the count came from the fallback', () => {
    // The tone read only the backlog while the value fell back to today's count, so a
    // real three people waiting rendered calm.
    const stats = serviceStats({
      today: { created: 10, replied: 6, spam: 1, needs_human: 3 },
      people: [],
      recent_tickets: []
    } as never)
    const needsHuman = stats.find((stat) => stat.id === 'needs_human')
    expect(needsHuman?.value).toBe(3)
    expect(needsHuman?.tone).toBe('warn')
  })

  it('stays calm when the backlog says nobody is waiting', () => {
    const stats = serviceStats({
      today: { created: 10, replied: 10, spam: 0, needs_human: 3 },
      backlog: { open_now: 0, needs_human_now: 0, oldest_open: null },
      people: [],
      recent_tickets: []
    } as never)
    const needsHuman = stats.find((stat) => stat.id === 'needs_human')
    // The backlog is the better source and it wins; the tone follows the same figure.
    expect(needsHuman?.value).toBe(0)
    expect(needsHuman?.tone).toBe('neutral')
  })

  it('reports nothing when neither source counted', () => {
    const stats = serviceStats({ today: {}, people: [], recent_tickets: [] } as never)
    expect(stats.find((stat) => stat.id === 'needs_human')?.value).toBeNull()
  })
})
