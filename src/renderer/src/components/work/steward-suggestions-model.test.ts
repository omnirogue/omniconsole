import { describe, expect, it } from 'vitest'
import type { StewardSuggestion } from '../../../../shared/session-steward-suggestions'
import { hasStewardSuggestionRows, stewardSuggestionRows } from './steward-suggestions-model'

function suggestion(
  id: string,
  kind: StewardSuggestion['kind'],
  keys: string[],
  state: StewardSuggestion['state'] = 'open'
): StewardSuggestion {
  return {
    id,
    kind,
    createdAt: 1,
    expiresAt: 2,
    targets: keys.map((sessionKey) => ({ sessionKey })),
    proposal: null,
    title: id,
    evidence: '',
    state,
    pairKey: `${kind}:${keys.join('|')}`
  }
}

describe('steward suggestion rows in Work', () => {
  it('shows paused notices, up to five offers and the couldn’t-place count', () => {
    const offers = Array.from({ length: 6 }, (_, index) =>
      suggestion(`m${index}`, index % 2 ? 'project' : 'merge', [`a${index}`, `b${index}`])
    )
    const rows = stewardSuggestionRows({
      suggestions: [
        ...offers,
        suggestion('u1', 'unplaced', ['x', 'y', 'z']),
        suggestion('gone', 'merge', ['c', 'd'], 'dismissed')
      ],
      paused: [{ feature: 'refile', corrected: 3, samples: 8, pausedAt: 5 }]
    })
    expect(rows.paused).toEqual([{ feature: 'refile', corrected: 3, samples: 8, pausedAt: 5 }])
    expect(rows.offers.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(rows.unplaced).toEqual({ id: 'u1', count: 3 })
    expect(hasStewardSuggestionRows(rows)).toBe(true)
  })

  it('renders nothing before the first read or when there is nothing to answer', () => {
    expect(hasStewardSuggestionRows(stewardSuggestionRows(null))).toBe(false)
    expect(
      hasStewardSuggestionRows(
        stewardSuggestionRows({ suggestions: [suggestion('u', 'unplaced', [])], paused: [] })
      )
    ).toBe(false)
  })
})
