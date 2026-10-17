import { describe, expect, it } from 'vitest'
import {
  GRAPH_HARD_LIMIT_PREFIX,
  graphFrameLimits,
  graphShortlistRubric,
  type GraphShortlistPlan
} from './graph-frame-limits'
import type { GraphItem } from './graph-items'
import { graphShortlist } from './graph-shortlist'

const item = (key: string, source = 'options/a0'): GraphItem => ({
  key,
  title: key.toUpperCase(),
  detail: `Option ${key}`,
  location: '',
  severity: 'none',
  round: 1,
  sourceCallId: source,
  repeats: 0
})
const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, index) => item(key, `options/a${index % 2}`))
const plan = (
  limitLines: number,
  change: Partial<GraphShortlistPlan> = {}
): GraphShortlistPlan => ({
  rubric: '',
  limitLines,
  unscreened: [],
  limits: limitLines ? { state: 'listed', limits: ['x'] } : { state: 'none' },
  ...change
})
const screen = (
  scores: Record<string, number>,
  criteria: Record<string, Record<string, number>>
) => ({
  value: {
    markdown: 'x',
    scores,
    criteria: Object.entries(criteria).map(([label, values], index) => ({
      id: `c${index + 1}`,
      label,
      scores: values
    })),
    unscored: []
  }
})
const ALL = (value: number) => ({ a: value, b: value, c: value, d: value, e: value, f: value })

describe('the Decide shortlist', () => {
  it('drops hard-limit breakers, then keeps the best, each leader and a wildcard', () => {
    const outcome = screen(
      { a: 3.8, b: 3.5, c: 2, d: 1.5, e: 3.9, f: 1 },
      {
        limits: { a: 4, b: 4, c: 4, d: 4, e: 0.5, f: 4 },
        fast: { a: 4, b: 2, c: 3.9, d: 1, e: 4, f: 2 },
        cheap: { a: 3, b: 4, c: 1, d: 1, e: 4, f: 1 }
      }
    )
    const result = graphShortlist('Develop', ITEMS, outcome, 4, plan(1))
    // e scores best overall but breaks a hard limit; c leads on nothing but spikes on "fast".
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.note).toContain('1 option broke a hard limit and was dropped (E)')
    expect(result.note).toContain(
      'A (best overall); B (leads on cheap); C (wildcard); D (next best)'
    )
    expect(result.ordered[0].jev).toEqual({ score: 3.8 })
    expect(result.unranked).toBeUndefined()
  })

  it('judges every hard limit on its own: breaking any one of them drops the option', () => {
    const outcome = screen(
      { a: 3, b: 3.5, c: 2 },
      { budget: { a: 4, b: 4, c: 4 }, region: { a: 4, b: 0, c: 4 }, fast: { a: 3, b: 4, c: 1 } }
    )
    const result = graphShortlist('Develop', ITEMS.slice(0, 3), outcome, 4, plan(2))
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'c'])
    expect(result.note).toContain('1 option broke a hard limit and was dropped (B)')
  })

  it('names each distinct leader, and says when the frame named no limits', () => {
    const outcome = screen(
      { a: 3, b: 2, c: 2, d: 1 },
      { speed: { a: 1, b: 4, c: 1, d: 1 }, cost: { a: 1, b: 1, c: 4, d: 1 } }
    )
    const result = graphShortlist('Develop', ITEMS.slice(0, 4), outcome, 3, plan(0))
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'b', 'c'])
    expect(result.note).toContain('the frame named no hard limits, so none was dropped')
  })

  it('never ranks or drops an option JEV could not score in full, and names it as a gap', () => {
    // b has no overall score; c has one but no score on the hard limit.
    const outcome = screen(
      { a: 3, c: 3.5, d: 1, e: 0.5, f: 0.2 },
      { limits: { a: 4, b: 4, d: 4, e: 4, f: 4 }, fast: { a: 2, b: 2, c: 4, d: 1, e: 1, f: 1 } }
    )
    const result = graphShortlist('Develop', ITEMS, outcome, 4, plan(1))
    // The unscored go right after the best, before the optional leader and wildcard picks.
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.ordered.find((entry) => entry.key === 'b')?.jev).toBeUndefined()
    expect(result.unranked).toBe(
      'JEV could not score 2 options in full, so they were neither ranked nor dropped.'
    )
    // Too little room: the best still goes on, and the shortlist says it is inconclusive.
    const tight = graphShortlist('Develop', ITEMS, outcome, 2, plan(1))
    expect(tight.ordered.map((entry) => entry.key)).toEqual(['a', 'b'])
    expect(tight.unranked).toContain(
      'the shortlist is inconclusive: 1 of them did not fit and was not developed (C)'
    )
  })

  it('never lets one failed score push the best eligible option off the shortlist', () => {
    // JEV scored every option but f; a is best, b–d lead a line each, e is the wildcard.
    const outcome = screen(
      { a: 3.9, b: 3, c: 3, d: 3, e: 2 },
      {
        limits: { a: 4, b: 4, c: 4, d: 4, e: 4, f: 4 },
        x: { a: 1, b: 4, c: 1, d: 1, e: 1 },
        y: { a: 1, b: 1, c: 4, d: 1, e: 1 },
        z: { a: 1, b: 1, c: 1, d: 4, e: 3.5 }
      }
    )
    const result = graphShortlist('Develop', ITEMS, outcome, 4, plan(1))
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'f', 'b', 'c'])
  })

  it('names limits the screen could not check, and an unreadable list, as gaps', () => {
    const outcome = screen(ALL(3), { fast: ALL(2) })
    const unscreened = plan(0, {
      limits: { state: 'listed', limits: ['x'] },
      unscreened: ['Must run in the EU']
    })
    expect(graphShortlist('Develop', ITEMS, outcome, 2, unscreened).unranked).toContain(
      "1 hard limit did not fit JEV's screen, so no option was checked against it (Must run in the EU)"
    )
    const unreadable = plan(0, { limits: { state: 'unreadable' } })
    const result = graphShortlist('Develop', ITEMS, outcome, 2, unreadable)
    expect(result.unranked).toContain("the frame's hard limits could not be read as a list")
    expect(result.note).not.toContain('named no hard limits')
  })

  it('says so when every option breaks a hard limit', () => {
    const outcome = screen({ a: 3, b: 3 }, { limits: { a: 0, b: 0.5 }, fast: { a: 3, b: 3 } })
    const result = graphShortlist('Develop', ITEMS.slice(0, 2), outcome, 4, plan(1))
    expect(result.ordered).toEqual([])
    expect(result.empty).toBe(
      'Nothing to develop: JEV judged that all 2 options break a hard limit.'
    )
  })

  it('falls back to alternating between models, as a gap, when JEV cannot screen', () => {
    const failed = { value: { markdown: 'x', error: 'no TypeSafe API key' } }
    const result = graphShortlist('Develop', ITEMS, failed, 3, plan(1))
    expect(result.ordered.map((entry) => entry.key)).toEqual(['a', 'b', 'c'])
    expect(result.unranked).toContain('JEV could not screen the options (no TypeSafe API key)')
    expect(result.unranked).toContain('none was checked against the hard limits')
  })
})

describe("the frame's hard limits", () => {
  const frame = (limits: string) =>
    `## Decision\nPick.\n## Hard limits${limits}\n## Rubric\n- A?\n- B?`

  it('reads a list, an explicit none, and anything else as unreadable, never as none', () => {
    expect(graphFrameLimits(frame('\n- Under $500\n- In the EU'))).toEqual({
      state: 'listed',
      limits: ['Under $500', 'In the EU']
    })
    expect(graphFrameLimits(frame(': None stated.'))).toEqual({ state: 'none' })
    expect(graphFrameLimits(frame('\n- None stated.'))).toEqual({ state: 'none' })
    expect(graphFrameLimits(frame('\nIt must be cheap and legal.'))).toEqual({
      state: 'unreadable'
    })
    expect(graphFrameLimits('## Decision\nPick.')).toEqual({ state: 'unreadable' })
    expect(graphFrameLimits(undefined)).toEqual({ state: 'unreadable' })
  })

  it('screens each limit on its own line, and never cuts one to fit', () => {
    const long = `Never ${'x'.repeat(300)}`
    const many = Array.from({ length: 10 }, (_, index) => `- Limit ${index + 1}`).join('\n')
    const fits = graphShortlistRubric(frame(`\n- Under $500\n- ${long}\n${many}`))
    expect(fits.rubric.split('\n').slice(0, 2)).toEqual([
      `${GRAPH_HARD_LIMIT_PREFIX} Under $500?`,
      `${GRAPH_HARD_LIMIT_PREFIX} Limit 1?`
    ])
    // Twelve lines in all: two rubric lines leave room for ten limits.
    expect(fits.limitLines).toBe(10)
    expect(fits.unscreened).toEqual([long, 'Limit 10'])
    expect(fits.rubric.split('\n').slice(-2)).toEqual(['- A?', '- B?'])
  })
})
