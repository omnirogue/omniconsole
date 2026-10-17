import { describe, expect, it } from 'vitest'
import {
  filterHandoffPeople,
  handoffPeopleMayBeIncomplete,
  type HandoffPerson
} from './handoff-people'
const self = { id: 'emp_self', name: 'Self' }
const other = { id: 'emp_other', name: 'Other' }
const filter = (roster: HandoffPerson[], company_scope: 'all' | string[] = []) =>
  filterHandoffPeople({
    roster,
    me: { employee_id: self.id, company_scope },
    folders: {
      ok: true,
      companies: [{ id: 'co_a', slug: 'a', domains: [{ id: 'sales', name: 'Sales' }] }]
    }
  })
describe('handoff people', () => {
  it('preserves server-authorized people for a member with no company grants', () => {
    const roster = [
      { ...other, companies: [] },
      { ...self, companies: [], department: 'Development' }
    ]
    const input = { roster, me: { company_scope: [] }, folders: null }
    expect(filterHandoffPeople({ ...input, serverScoped: true })).toEqual(roster)
    expect(handoffPeopleMayBeIncomplete({ ...input, serverScoped: true })).toBe(false)
    expect(filterHandoffPeople(input)).toEqual([])
    expect(handoffPeopleMayBeIncomplete(input)).toBe(true)
  })
  it('keeps the reader in the list, in roster order', () => {
    expect(filter([self, other])).toEqual([self, other])
    expect(filter([self])).toEqual([self])
    expect(filter([])).toEqual([])
  })
  it('filters company and department metadata through the reader scope', () => {
    const a = { ...other, companies: ['co_a'] }
    const b = { id: 'emp_b', name: 'B', companies: ['b'] }
    const sales = { id: 'emp_sales', name: 'Sales', department: 'Sales' }
    expect(filter([a, b, sales], ['a'])).toEqual([a, sales])
    expect(filter([a, b, sales], [])).toEqual([])
  })
  it('keeps only explicit company overlap when the folders could not be read', () => {
    const unknown = (roster: HandoffPerson[], company_scope: 'all' | string[] = []) =>
      filterHandoffPeople({ roster, me: { employee_id: self.id, company_scope }, folders: null })
    const mine = { ...other, companies: ['a'] }
    const nobody = { id: 'emp_x', name: 'X' }
    expect(unknown([mine, nobody], ['a'])).toEqual([mine])
    // Why: with the map unread, an all-scope reader still sees everyone.
    expect(unknown([mine, nobody], 'all')).toEqual([mine, nobody])
    expect(handoffPeopleMayBeIncomplete({ me: { company_scope: ['a'] }, folders: null })).toBe(true)
    expect(handoffPeopleMayBeIncomplete({ me: { company_scope: 'all' }, folders: null })).toBe(
      false
    )
  })
  it('keeps unannotated active humans and lets all-scope readers see everyone else', () => {
    expect(filter([other])).toEqual([other])
    const b = { ...other, companies: ['b'] }
    expect(filter([self, b], 'all')).toEqual([self, b])
  })
})
