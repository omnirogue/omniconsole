import { describe, expect, it } from 'vitest'
import {
  additionalCompanySlugs,
  companyTag,
  fitsCardTagBounds,
  isProposedTask,
  newTaskTags,
  taskCompanySlugs,
  unfitCompanySlugs,
  withAdditionalCompanies,
  withProposed
} from './proposed-task'

describe('proposed-task tags', () => {
  it('reads the proposed marker and ignores surrounding space', () => {
    expect(isProposedTask(['proposed'])).toBe(true)
    expect(isProposedTask([' proposed '])).toBe(true)
    expect(isProposedTask(['company:betacorp'])).toBe(false)
    expect(isProposedTask(null)).toBe(false)
  })

  it('adds and removes the marker without touching other tags', () => {
    expect(withProposed(['company:betacorp'], true)).toEqual(['proposed', 'company:betacorp'])
    expect(withProposed(['proposed', 'company:betacorp', 'proposed'], false)).toEqual([
      'company:betacorp'
    ])
    expect(withProposed(undefined, true)).toEqual(['proposed'])
  })

  it('lists every company the card is for, the filed one first, without duplicates', () => {
    const tags = ['proposed', 'company:OmniRogue', 'company:betacorp', 'company:betacorp']
    expect(additionalCompanySlugs(tags, 'betacorp')).toEqual(['omnirogue'])
    expect(taskCompanySlugs('BetaCorp', tags)).toEqual(['betacorp', 'omnirogue'])
    expect(taskCompanySlugs(null, tags)).toEqual(['omnirogue', 'betacorp'])
  })

  it('replaces the company tags, never tagging the primary company or an unfit slug', () => {
    const tags = withAdditionalCompanies(
      ['proposed', 'company:old'],
      ['omnirogue', 'betacorp', 'BetaCorp', 'x'.repeat(60)],
      'betacorp'
    )
    expect(tags).toEqual(['proposed', 'company:omnirogue'])
    expect(companyTag(' OmniRogue ')).toBe('company:omnirogue')
  })

  it('files a new card with only the tags it needs', () => {
    expect(newTaskTags({})).toEqual([])
    expect(
      newTaskTags({
        proposed: true,
        primarySlug: 'betacorp',
        additionalCompanySlugs: ['omnirogue']
      })
    ).toEqual(['proposed', 'company:omnirogue'])
  })

  it('names the companies whose tag would not fit, so nobody is dropped in silence', () => {
    const long = 'x'.repeat(40)
    expect(unfitCompanySlugs(['omnirogue', long, ' '])).toEqual([long])
  })

  it('knows the hub bounds', () => {
    expect(fitsCardTagBounds(['proposed'])).toBe(true)
    expect(fitsCardTagBounds(Array.from({ length: 21 }, (_, i) => `t${i}`))).toBe(false)
    expect(fitsCardTagBounds(['x'.repeat(41)])).toBe(false)
  })
})

it('reads and replaces reserved tags without case duplicates', () => {
  expect(isProposedTask(['Proposed'])).toBe(true)
  expect(withProposed(['Proposed', 'PROPOSED', 'company:alpha'], true)).toEqual([
    'proposed',
    'company:alpha'
  ])
  expect(withProposed(['Proposed', 'company:alpha'], false)).toEqual(['company:alpha'])
  expect(additionalCompanySlugs(['Company:Alpha', 'company:alpha'])).toEqual(['alpha'])
})
