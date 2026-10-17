import { describe, expect, it } from 'vitest'
import { mergeCompanyRows } from './CompaniesPage'

describe('mergeCompanyRows', () => {
  it('lists every available org company, with rollup counts when the rollup answered', () => {
    const rows = mergeCompanyRows(
      [
        { id: 'co_1', slug: 'omnirogue', name: 'OmniRogue', available: true, domains: [] },
        { id: 'co_2', slug: 'acme', name: 'ACME', available: true, domains: [] },
        { id: 'co_3', slug: 'retired', name: 'Retired', available: false, domains: [] }
      ],
      [{ company_id: 'co_1', slug: 'omnirogue', name: 'OmniRogue', active: 3, failed: 1 }]
    )
    expect(rows.map((row) => row.slug)).toEqual(['omnirogue', 'acme'])
    expect(rows[0].active).toBe(3)
    // Why: a company the rollup did not answer keeps unknown counts, never zero.
    expect(rows[1].active).toBeNull()
  })

  it('still shows a company the rollup knows but the org tree does not', () => {
    const rows = mergeCompanyRows(
      [{ id: 'co_1', slug: 'omnirogue', name: 'OmniRogue', available: true, domains: [] }],
      [{ company_id: 'co_9', slug: 'legacy', name: 'Legacy', active: 0 }]
    )
    expect(rows.map((row) => row.slug)).toEqual(['omnirogue', 'legacy'])
  })

  it('answers the empty estate as an empty list', () => {
    expect(mergeCompanyRows([], [])).toEqual([])
  })
})
