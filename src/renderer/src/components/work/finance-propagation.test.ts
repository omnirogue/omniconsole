import { describe, expect, it } from 'vitest'
import { financeStats } from './finance-stats'
import { companyMoneyRows } from './work-model'
import {
  marginPct,
  reportedAmount,
  scorecardDay,
  scorecardDocument,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/**
 * The sibling paths a fix has to reach.
 *
 * A review found that a margin was computed from operands the window itself had
 * withheld. Fixing `marginPct` was not the end of it: the company list built its own
 * margin by reading `finance.today.margin_pct` raw, so the same defect survived one
 * function away. That is the incomplete-propagation class, and these tests are how it
 * stays fixed — they assert the rule at EVERY place the figure is produced, not just
 * at the one the review happened to name.
 */

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
          pnl: 700,
          api_cost_available: true
        },
        days: [],
        sources: []
      }
    ],
    ...over
  })
}

/** A window whose P&L the source never reported, with a margin supplied anyway. */
const UNVOUCHED = {
  today: { reported: ['revenue'], revenue: 1000, pnl: 700, margin_pct: 70 }
} as const
/** The same figures, fully reported. */
const VOUCHED = {
  today: { reported: ['revenue', 'pnl'], revenue: 1000, pnl: 700, margin_pct: 70 }
} as const

describe('a withheld operand withholds everything derived from it', () => {
  it('refuses the margin in the finance tiles', () => {
    const withheld = financeStats(document().companies[0], UNVOUCHED as never).find(
      (stat) => stat.id === 'margin_today'
    )
    expect(withheld?.value).toBeNull()
    const shown = financeStats(document().companies[0], VOUCHED as never).find(
      (stat) => stat.id === 'margin_today'
    )
    expect(shown?.value).toBe(70)
  })

  it('refuses the same margin in the company list, which builds its own', () => {
    // This is the sibling. Before the propagation fix it read margin_pct raw and
    // reported 70 while the tiles beside it correctly reported nothing.
    const unvouched = companyMoneyRows(document({ finance: { omnirogue: UNVOUCHED } }))
    expect(unvouched[0].marginPct).toBeNull()
    const vouched = companyMoneyRows(document({ finance: { omnirogue: VOUCHED } }))
    expect(vouched[0].marginPct).toBe(70)
  })

  it('agrees between the two surfaces on every case', () => {
    // The point of the test: one rule, two readers, no disagreement. A figure shown in
    // one place and withheld in the other is worse than either answer alone.
    for (const finance of [UNVOUCHED, VOUCHED, { today: { revenue: 0, pnl: -5 } }]) {
      const tile = financeStats(document().companies[0], finance as never).find(
        (stat) => stat.id === 'margin_today'
      )
      const row = companyMoneyRows(document({ finance: { omnirogue: finance } }))[0]
      expect(row.marginPct, JSON.stringify(finance)).toBe(tile?.value ?? null)
    }
  })

  it('withholds a margin over no revenue, rather than calling it nought per cent', () => {
    expect(marginPct({ reported: ['revenue', 'pnl'], revenue: 0, pnl: -5 } as never)).toBeNull()
  })

  it('withholds a margin whose revenue Stripe truncated', () => {
    expect(
      marginPct({
        reported: ['revenue', 'pnl'],
        stripe_truncated: true,
        revenue: 1000,
        pnl: 700,
        margin_pct: 70
      } as never)
    ).toBeNull()
  })
})

describe('the field reader behind both surfaces', () => {
  it('reports a field the source named', () => {
    expect(reportedAmount({ reported: ['revenue'], revenue: 10 } as never, 'revenue')).toBe(10)
  })

  it('withholds a field the source did not name, even with a number sitting there', () => {
    expect(
      reportedAmount({ reported: ['revenue'], revenue: 10, pnl: 7 } as never, 'pnl')
    ).toBeNull()
  })

  it('withholds P&L the source explicitly disowned', () => {
    expect(
      reportedAmount(
        { reported: ['revenue', 'pnl'], revenue: 10, pnl: 7, pnl_reported: false } as never,
        'pnl'
      )
    ).toBeNull()
  })

  it('keeps ad spend when only the Stripe side was truncated', () => {
    const window = {
      reported: ['revenue', 'ad_spend'],
      stripe_truncated: true,
      revenue: 10,
      ad_spend: 4
    } as never
    expect(reportedAmount(window, 'revenue')).toBeNull()
    expect(reportedAmount(window, 'ad_spend')).toBe(4)
  })
})

describe('a note may not contradict the figure beside it', () => {
  it('says the cost source did not answer only when no figure is shown', () => {
    // The API-cost tile draws from three sources in turn. Keying its note on two of
    // them let it show a figure from the third while claiming nothing was reported.
    const fromDayRow = financeStats(
      document({
        companies: [
          {
            slug: 'omnirogue',
            name: 'OmniRogue',
            today: {
              date: '2026-09-12',
              reported: ['api_cost'],
              api_cost: 42,
              api_cost_available: true
            },
            days: [],
            sources: []
          }
        ]
      }).companies[0],
      undefined
    ).find((stat) => stat.id === 'api_cost')
    expect(fromDayRow?.value).toBe(42)
    expect(fromDayRow?.withheld).toBeUndefined()
  })

  it('says so when truly nothing answered', () => {
    const nothing = financeStats(
      document({
        companies: [
          {
            slug: 'omnirogue',
            name: 'OmniRogue',
            today: {
              date: '2026-09-12',
              reported: ['revenue'],
              revenue: 1,
              api_cost_available: true
            },
            days: [],
            sources: []
          }
        ]
      }).companies[0],
      undefined
    ).find((stat) => stat.id === 'api_cost')
    expect(nothing?.value).toBeNull()
    expect(nothing?.withheld).toContain('did not answer')
  })
})

describe('the third reader of a truncated day', () => {
  it('withholds revenue and P&L from the Work home company table', async () => {
    const { moneyOf } = await import('./work-model')
    // Parsed rather than hand-typed, so the fixture is a real decoded day.
    const day = scorecardDay.parse({
      date: '2026-09-12',
      reported: ['revenue', 'ad_spend', 'pnl'],
      stripe_truncated: true,
      revenue: 1000,
      ad_spend: 300,
      pnl: 650
    })
    // Two siblings already checked this; this reader did not, so the same day showed as
    // a verified figure here and as unknown in the tiles beside it.
    expect(moneyOf(day, 'revenue')).toEqual({ kind: 'unknown', reason: 'missing' })
    expect(moneyOf(day, 'pnl')).toEqual({ kind: 'unknown', reason: 'missing' })
    // Ad spend comes from a different source and survives.
    expect(moneyOf(day, 'ad_spend')).toEqual({ kind: 'value', value: 300 })
  })

  it('agrees with the finance tiles on the same truncated day', async () => {
    const { moneyOf } = await import('./work-model')
    const truncated = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: {
            date: '2026-09-12',
            reported: ['revenue', 'pnl'],
            stripe_truncated: true,
            revenue: 1000,
            pnl: 650,
            api_cost_available: true
          },
          days: [],
          sources: []
        }
      ]
    })
    const tile = financeStats(truncated.companies[0], undefined).find(
      (stat) => stat.id === 'revenue'
    )
    expect(tile?.value).toBeNull()
    expect(moneyOf(truncated.companies[0].today, 'revenue').kind).toBe('unknown')
  })

  it('still reports an untruncated day', async () => {
    const { moneyOf } = await import('./work-model')
    expect(
      moneyOf(scorecardDay.parse({ reported: ['revenue'], revenue: 1000 }), 'revenue')
    ).toEqual({ kind: 'value', value: 1000 })
  })
})

describe('P&L reads from the day row like its three siblings', () => {
  it('shows a reported P&L when there is no finance window at all', () => {
    const onlyDay = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['pnl'], pnl: 650, api_cost_available: true },
          days: [],
          sources: []
        }
      ]
    })
    // Before this fix P&L was the one field with no fallback, so a real figure read as unknown.
    expect(financeStats(onlyDay.companies[0], undefined).find((s) => s.id === 'pnl')?.value).toBe(
      650
    )
  })

  it('still withholds a P&L the day row did not report', () => {
    const silent = document({
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: { date: '2026-09-12', reported: ['revenue'], revenue: 1, pnl: 650 },
          days: [],
          sources: []
        }
      ]
    })
    expect(
      financeStats(silent.companies[0], undefined).find((s) => s.id === 'pnl')?.value
    ).toBeNull()
  })
})
