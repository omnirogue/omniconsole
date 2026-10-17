import { describe, expect, it } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import {
  ARTIFACT_LIST_FILTERS,
  artifactListStateForFilter,
  DEFAULT_ARTIFACT_LIST_FILTER,
  groupArtifactsBySession
} from './artifact-list-filter'
import {
  artifactHeaderSelectionState,
  toggleAllArtifactSelection,
  toggleArtifactSelection
} from './artifact-selection'

function row(slug: string, updatedAt: string, sessionRef: string | null): ArtifactListItem {
  return {
    artifact: {
      version: 1,
      slug,
      title: slug,
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: updatedAt,
      updatedAt,
      expiresAt: updatedAt,
      byteSize: 1,
      deletedAt: null
    },
    shareUrl: `https://omnios.example/a/${slug}`,
    sessionRef
  }
}

describe('filter → state', () => {
  it('maps Needs me · Open · Closed · All, defaulting to Open', () => {
    expect(ARTIFACT_LIST_FILTERS.map(artifactListStateForFilter)).toEqual([
      'needs_me',
      'open',
      'closed',
      undefined
    ])
    expect(DEFAULT_ARTIFACT_LIST_FILTER).toBe('open')
  })
})

describe('group by session', () => {
  it('puts the newest session first and rows without a session last', () => {
    const groups = groupArtifactsBySession(
      [
        row('a1', '2026-09-01T00:00:00Z', 'als_a'),
        row('none', '2026-09-30T00:00:00Z', null),
        row('b1', '2026-09-10T00:00:00Z', 'als_b'),
        row('a2', '2026-09-20T00:00:00Z', 'als_a')
      ],
      (item) => `Session ${item.sessionRef}`,
      'No session'
    )
    expect(
      groups.map((group) => [group.label, group.items.map((item) => item.artifact.slug)])
    ).toEqual([
      ['Session als_a', ['a1', 'a2']],
      ['Session als_b', ['b1']],
      ['No session', ['none']]
    ])
  })
})

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd']

  it('toggles one row, and Shift-click selects the range from the anchor', () => {
    const one = toggleArtifactSelection(new Set(), 'b', { shift: false, anchor: null, order })
    expect([...one]).toEqual(['b'])
    const range = toggleArtifactSelection(one, 'd', { shift: true, anchor: 'b', order })
    expect([...range].toSorted()).toEqual(['b', 'c', 'd'])
    expect(
      [...toggleArtifactSelection(range, 'c', { shift: false, anchor: 'd', order })].toSorted()
    ).toEqual(['b', 'd'])
  })

  it('header box selects all visible rows, then clears them', () => {
    expect(artifactHeaderSelectionState(new Set(['a']), order)).toBe('indeterminate')
    const all = toggleAllArtifactSelection(new Set(['a']), order)
    expect(artifactHeaderSelectionState(all, order)).toBe(true)
    expect(toggleAllArtifactSelection(all, order).size).toBe(0)
  })
})
