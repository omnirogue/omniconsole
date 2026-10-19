import { describe, expect, it } from 'vitest'
import {
  duplicateRosterNames,
  foldPersonName,
  resolveRosterName,
  rosterPersonDetail,
  searchRoster
} from './team-roster-search'

const roster = [
  { id: 'emp_iris', name: 'Iriis Ahmed', role: 'QA', department: 'Engineering' },
  { id: 'emp_gamma', name: 'Gamma Rossi' },
  { id: 'emp_josh1', name: 'José García', department: 'Support' },
  { id: 'emp_josh2', name: 'Josh Garcia', department: 'Sales' },
  { id: 'emp_eve', name: 'Eve Barnett', title: 'Operations lead' }
]

describe('team roster search', () => {
  it('folds case, accents and doubled letters the same way on both sides', () => {
    expect(foldPersonName('Iriis')).toBe(foldPersonName('IRIS'))
    expect(foldPersonName('Íris')).toBe('iris')
    expect(foldPersonName("O'Brien-Smith")).toBe('o brien smith')
  })

  it('resolves spelling variants and first names to the one person', () => {
    expect(resolveRosterName('Iris', roster)).toMatchObject({
      kind: 'match',
      person: { id: 'emp_iris' }
    })
    expect(resolveRosterName('iriis ahmed', roster)).toMatchObject({
      kind: 'match',
      person: { id: 'emp_iris' }
    })
    expect(resolveRosterName('GALO', roster)).toMatchObject({
      kind: 'match',
      person: { id: 'emp_gamma' }
    })
  })

  it('returns shared names as an explicit choice, never a silent pick', () => {
    const full = resolveRosterName('josh garcia', roster)
    expect(full.kind).toBe('choice')
    expect(full.kind === 'choice' && full.candidates.map((person) => person.id)).toEqual([
      'emp_josh1',
      'emp_josh2'
    ])
    expect(resolveRosterName('Josh', roster).kind).toBe('choice')
  })

  it('offers a near spelling only as a choice to confirm', () => {
    expect(resolveRosterName('Irim', roster)).toMatchObject({
      kind: 'choice',
      candidates: [{ id: 'emp_iris' }]
    })
    expect(resolveRosterName('Bob', roster)).toEqual({ kind: 'none', query: 'Bob' })
    expect(resolveRosterName('  ', roster)).toEqual({ kind: 'none', query: '  ' })
  })

  it('filters the whole loaded roster once per person, counting matches past the page', () => {
    const pagesWithRepeat = [...roster, { id: 'emp_iris', name: 'Iriis Ahmed' }]
    const firstPage = searchRoster(pagesWithRepeat, '', 2)
    expect(firstPage.total).toBe(5)
    expect(firstPage.people.map((person) => person.id)).toEqual(['emp_eve', 'emp_gamma'])
    expect(searchRoster(pagesWithRepeat, 'engineering', 10).people.map((p) => p.id)).toEqual([
      'emp_iris'
    ])
    expect(searchRoster(pagesWithRepeat, 'josh', 1)).toMatchObject({ total: 2 })
    expect(searchRoster(pagesWithRepeat, 'iris', 10).people.map((p) => p.id)).toEqual([
      'emp_iris'
    ])
  })

  it('names duplicates and shows what the roster carries about each person', () => {
    expect([...duplicateRosterNames(roster)]).toEqual(['josh garcia'])
    expect(rosterPersonDetail(roster[0]!)).toBe('QA · Engineering')
    expect(rosterPersonDetail(roster[4]!)).toBe('Operations lead')
    expect(rosterPersonDetail(roster[1]!)).toBeNull()
  })
})
