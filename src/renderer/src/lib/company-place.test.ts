import { describe, expect, it } from 'vitest'
import { companyPlaceForPath } from './company-place'

const HOME = '/Users/maintainer'
const companies = [
  {
    id: 'c-omnirogue',
    slug: 'omnirogue',
    name: 'OmniRogue',
    status: null,
    count: 2,
    domains: [
      {
        id: 'd-sales',
        name: 'Sales',
        count: 1,
        parent_unit_id: null,
        projects: [{ id: 'proj-q4', name: 'Q4 push', kind: 'project', status: 'active' }]
      }
    ]
  },
  { id: 'c-acme', slug: 'acme', name: 'ACME', status: null, count: 0, domains: [] }
]
const context = { home: HOME, workRoot: null, overrides: null }

describe('companyPlaceForPath', () => {
  it('names the company and the deepest department a path sits in', () => {
    expect(companyPlaceForPath(companies, `${HOME}/Work/OmniRogue/Sales/q4`, context)).toEqual({
      company: { id: 'c-omnirogue', slug: 'omnirogue', name: 'OmniRogue' },
      domain: { id: 'd-sales', name: 'Sales' },
      project: null
    })
    expect(
      companyPlaceForPath(companies, `${HOME}/Work/OmniRogue/Sales/Q4 push/site`, context)
    ).toEqual({
      company: { id: 'c-omnirogue', slug: 'omnirogue', name: 'OmniRogue' },
      domain: { id: 'd-sales', name: 'Sales' },
      project: { id: 'proj-q4', name: 'Q4 push' }
    })
    expect(companyPlaceForPath(companies, `${HOME}/Work/OmniRogue`, context)).toEqual({
      company: { id: 'c-omnirogue', slug: 'omnirogue', name: 'OmniRogue' },
      domain: null,
      project: null
    })
  })

  it('is null outside every company, without a path, or before home is known', () => {
    expect(companyPlaceForPath(companies, `${HOME}/Desktop/x`, context)).toBeNull()
    expect(companyPlaceForPath(companies, null, context)).toBeNull()
    expect(companyPlaceForPath(companies, `${HOME}/Work/ACME`, { ...context, home: '' })).toBeNull()
  })

  it('follows a configured folder override', () => {
    expect(
      companyPlaceForPath(companies, `${HOME}/Clients/rogue/site`, {
        ...context,
        overrides: { omnirogue: '~/Clients/rogue' }
      })?.company.slug
    ).toBe('omnirogue')
  })
})
