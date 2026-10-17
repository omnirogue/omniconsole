import { describe, expect, it } from 'vitest'
import {
  INDEPENDENT_SESSION_TAG,
  defaultSessionTags,
  parseSessionTags,
  sessionTagIds,
  migrateSessionTags,
  matchesSessionTagFilter
} from './session-tags'
describe('session tags', () => {
  it('installs the four company defaults and preserves deliberate deletion on reload', () => {
    const data = defaultSessionTags()
    expect(data.tags.map((tag) => tag.name)).toEqual([
      'OmniRogue',
      'BetaCorp',
      'ACME',
      'OmniOS',
      'Independent'
    ])
    data.tags = []
    // The steward's own marker stays, so `omni session tag --add independent` always resolves.
    expect(parseSessionTags(JSON.parse(JSON.stringify(data))).tags).toEqual([
      INDEPENDENT_SESSION_TAG
    ])
    data.tags = [{ id: 'mine', name: 'independent', color: '#112233' }]
    expect(parseSessionTags(JSON.parse(JSON.stringify(data))).tags.map((tag) => tag.id)).toEqual([
      'mine'
    ])
  })
  it('does not restore an automatic tag after the person removes it', () => {
    const data = defaultSessionTags()
    expect(sessionTagIds(data, 'session', 'acme')).toEqual(['acme'])
    data.assignments.session = []
    expect(sessionTagIds(parseSessionTags(data), 'session', 'acme')).toEqual([])
  })
  it('moves provisional choices once and preserves explicit destination choices', () => {
    const data = { ...defaultSessionTags(), assignments: { pane: ['acme'] } }
    const migrated = migrateSessionTags(data, 'pane', 'provider')
    expect(migrated.assignments).toEqual({ provider: ['acme'] })
    expect(migrateSessionTags(migrated, 'pane', 'provider')).toBe(migrated)
    expect(
      migrateSessionTags(
        { ...data, assignments: { ...data.assignments, provider: [] } },
        'pane',
        'provider'
      ).assignments
    ).toEqual({ provider: [] })
  })
  it('matches any chosen tag and clears dangling filters and assignments', () => {
    expect(matchesSessionTagFilter(['acme'], ['betacorp', 'acme'])).toBe(true)
    expect(matchesSessionTagFilter([], ['acme'])).toBe(false)
    expect(matchesSessionTagFilter([], [])).toBe(true)
    expect(
      parseSessionTags({
        ...defaultSessionTags(),
        assignments: { s: ['deleted', 'acme'] },
        filter: ['deleted']
      })
    ).toMatchObject({ assignments: { s: ['acme'] }, filter: [] })
  })
  it('rejects duplicate names and malformed saved data rather than overwriting it', () => {
    const data = defaultSessionTags()
    expect(() =>
      parseSessionTags({
        ...data,
        tags: [...data.tags, { id: 'new', name: 'acme', color: '#0087ff' }]
      })
    ).toThrow()
    expect(() => parseSessionTags({ ...data, assignments: { s: 'acme' } })).toThrow()
  })
})
