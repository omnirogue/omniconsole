import { describe, expect, it } from 'vitest'
import {
  appendSessionGridPane,
  emptySessionGridLayout,
  insertSessionGridPane,
  moveSessionGridPane,
  normalizeSessionGridLayout,
  removeSessionGridPane,
  replaceSessionGridPane,
  resizeSessionGridShares,
  sessionGridPaneIds,
  type SessionGridLayout
} from './session-grid-layout'

function build(ids: string[]): SessionGridLayout {
  return ids.reduce((layout, id) => appendSessionGridPane(layout, id), emptySessionGridLayout())
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

describe('session grid layout', () => {
  it('opens two panes side by side and four as two by two', () => {
    expect(build(['a', 'b']).tracks).toEqual([['a'], ['b']])
    expect(build(['a', 'b', 'c']).tracks).toEqual([['a'], ['b', 'c']])
    expect(build(['a', 'b', 'c', 'd']).tracks).toEqual([
      ['a', 'd'],
      ['b', 'c']
    ])
  })

  it('keeps every size summing to one as panes come and go', () => {
    let layout = build(['a', 'b', 'c', 'd', 'e'])
    expect(sum(layout.trackSizes)).toBeCloseTo(1)
    layout = removeSessionGridPane(layout, 'b')
    layout = removeSessionGridPane(layout, 'c')
    expect(sum(layout.trackSizes)).toBeCloseTo(1)
    for (const shares of layout.paneSizes) {
      expect(sum(shares)).toBeCloseTo(1)
    }
    expect(sessionGridPaneIds(layout).sort()).toEqual(['a', 'd', 'e'])
  })

  it('puts a pane dropped on a side in a new column, and above or below in the same one', () => {
    const base = build(['a', 'b'])
    const right = insertSessionGridPane(base, 'c', { paneId: 'a', zone: 'right' })
    expect(right.tracks).toEqual([['a'], ['c'], ['b']])
    // Why: the new column takes half of the column it was dropped beside.
    expect(right.trackSizes).toEqual([0.25, 0.25, 0.5])
    const below = insertSessionGridPane(base, 'c', { paneId: 'a', zone: 'bottom' })
    expect(below.tracks).toEqual([['a', 'c'], ['b']])
    expect(below.paneSizes[0]).toEqual([0.5, 0.5])
  })

  it('reads sides the other way round in rows', () => {
    const rows = { ...build(['a', 'b']), orientation: 'rows' as const }
    expect(insertSessionGridPane(rows, 'c', { paneId: 'a', zone: 'bottom' }).tracks).toEqual([
      ['a'],
      ['c'],
      ['b']
    ])
    expect(insertSessionGridPane(rows, 'c', { paneId: 'a', zone: 'left' }).tracks).toEqual([
      ['c', 'a'],
      ['b']
    ])
  })

  it('swaps two panes dropped on each other and moves one dropped beside another', () => {
    const base = build(['a', 'b', 'c'])
    expect(moveSessionGridPane(base, 'a', { paneId: 'c', zone: 'center' }).tracks).toEqual([
      ['c'],
      ['b', 'a']
    ])
    expect(moveSessionGridPane(base, 'c', { paneId: 'a', zone: 'bottom' }).tracks).toEqual([
      ['a', 'c'],
      ['b']
    ])
  })

  it('replaces a pane in place', () => {
    const base = build(['a', 'b'])
    expect(replaceSessionGridPane(base, 'a', 'z')).toEqual({ ...base, tracks: [['z'], ['b']] })
  })

  it('never lets a divider squeeze a side below the minimum', () => {
    expect(resizeSessionGridShares([0.5, 0.5], 0, 0.99)).toEqual([0.9, 0.09999999999999998])
    expect(resizeSessionGridShares([0.5, 0.5], 0, 0.3)).toEqual([0.3, 0.7])
    expect(resizeSessionGridShares([0.5, 0.5], 1, 0.3)).toEqual([0.5, 0.5])
  })

  it('repairs a saved layout with empty tracks or broken sizes', () => {
    expect(
      normalizeSessionGridLayout({
        orientation: 'columns',
        tracks: [['a'], [], ['b']],
        trackSizes: [0.2, 0.3, 0.5],
        paneSizes: [[1], [], [Number.NaN]]
      })
    ).toEqual({
      orientation: 'columns',
      tracks: [['a'], ['b']],
      trackSizes: [0.5, 0.5],
      paneSizes: [[1], [1]]
    })
  })
})
