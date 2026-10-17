import { describe, expect, it } from 'vitest'
import { looseCount, looseNumber } from './console-scorecard-leaves'
import { scorecardDocument } from './console-scorecard-contract'

/**
 * The scorecard's numbers arrive as text sometimes.
 *
 * The console's own decoder coerces a numeric string and its comment says why: "Meta
 * reports spend as text". A schema that rejected it would refuse a live payload and
 * blank every figure in the document, where the console shows the number. So this is
 * fidelity to the source, not defensiveness — and it is the difference between the
 * Work home reading correctly on a real document and reading empty.
 */
describe('a figure reported as text is still a figure', () => {
  it('coerces a numeric string, as the console does', () => {
    for (const [input, expected] of [
      ['1234', 1234],
      ['12.5', 12.5],
      [' 7 ', 7],
      ['-3', -3],
      ['0', 0]
    ] as const) {
      const parsed = looseNumber.safeParse(input)
      expect(parsed.success, String(input)).toBe(true)
      expect(parsed.success && parsed.data, String(input)).toBe(expected)
    }
  })

  it('leaves an unparseable string unknown rather than rejecting the document', () => {
    for (const input of ['', '   ', 'abc', 'NaN', '12abc']) {
      const parsed = looseNumber.safeParse(input)
      expect(parsed.success, input).toBe(true)
      expect(parsed.success && parsed.data, input).toBeNull()
    }
  })

  it('still takes a real number, a null and an absent field', () => {
    expect(looseNumber.safeParse(1234).success && looseNumber.parse(1234)).toBe(1234)
    expect(looseNumber.parse(null)).toBeNull()
    expect(looseNumber.parse(undefined)).toBeUndefined()
    expect(looseCount.parse('9')).toBe(9)
  })

  it('reads a whole document whose money arrived as text', () => {
    // This is the case that mattered: one string in one field would otherwise have
    // rejected the document and blanked every stat on the Work home.
    const document = scorecardDocument.parse({
      generated_at: '2026-09-12T16:00:00Z',
      today: '2026-09-12',
      companies: [
        {
          slug: 'omnirogue',
          name: 'OmniRogue',
          today: {
            date: '2026-09-12',
            reported: ['revenue', 'ad_spend'],
            revenue: '1234.50',
            ad_spend: '300'
          },
          days: [],
          sources: []
        }
      ],
      finance: {
        omnirogue: { today: { reported: ['revenue'], revenue: '1234.50', margin_pct: '12.5' } }
      }
    })
    expect(document.companies[0].today?.revenue).toBe(1234.5)
    expect(document.companies[0].today?.ad_spend).toBe(300)
    expect(document.finance?.omnirogue.today?.margin_pct).toBe(12.5)
  })
})
