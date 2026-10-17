import { describe, expect, it } from 'vitest'
import {
  emptySessionSelection,
  extendSessionSelection,
  pruneSessionSelection,
  selectAllSessions,
  sessionSelectionIntent,
  stepSessionSelection,
  updateSessionSelection,
  type SessionSelection
} from './session-multi-selection'

const visibleKeys = ['a', 'b', 'c', 'd', 'e']

function selection(selected: string[], anchor: string, focus = anchor): SessionSelection {
  return { selected: new Set(selected), anchor, focus }
}

function keys(state: SessionSelection): string[] {
  return visibleKeys.filter((key) => state.selected.has(key))
}

describe('session multi selection', () => {
  it('reads Cmd on Mac and Ctrl elsewhere as toggle, Shift as range', () => {
    expect(sessionSelectionIntent({ metaKey: true, ctrlKey: false, shiftKey: false }, true)).toBe(
      'toggle'
    )
    expect(sessionSelectionIntent({ metaKey: true, ctrlKey: false, shiftKey: false }, false)).toBe(
      'replace'
    )
    expect(sessionSelectionIntent({ metaKey: false, ctrlKey: true, shiftKey: false }, false)).toBe(
      'toggle'
    )
    expect(sessionSelectionIntent({ metaKey: false, ctrlKey: false, shiftKey: true }, true)).toBe(
      'range'
    )
  })

  it('replaces on a plain click and anchors there', () => {
    const next = updateSessionSelection({
      visibleKeys,
      previous: selection(['a', 'b'], 'a'),
      targetKey: 'd',
      intent: 'replace'
    })
    expect(keys(next)).toEqual(['d'])
    expect(next.anchor).toBe('d')
    expect(next.focus).toBe('d')
  })

  it('toggles rows without dropping the rest and moves the anchor', () => {
    const on = updateSessionSelection({
      visibleKeys,
      previous: selection(['a'], 'a'),
      targetKey: 'c',
      intent: 'toggle'
    })
    expect(keys(on)).toEqual(['a', 'c'])
    expect(on.anchor).toBe('c')
    const off = updateSessionSelection({
      visibleKeys,
      previous: on,
      targetKey: 'a',
      intent: 'toggle'
    })
    expect(keys(off)).toEqual(['c'])
  })

  it('selects the visible span from the anchor on Shift+click', () => {
    const next = updateSessionSelection({
      visibleKeys,
      previous: selection(['b'], 'b'),
      targetKey: 'd',
      intent: 'range'
    })
    expect(keys(next)).toEqual(['b', 'c', 'd'])
    expect(next.anchor).toBe('b')
    expect(next.focus).toBe('d')
  })

  it('keeps ranges deterministic after toggles: the span runs from the last toggled row', () => {
    const toggled = updateSessionSelection({
      visibleKeys,
      previous: selection(['a'], 'a'),
      targetKey: 'c',
      intent: 'toggle'
    })
    const ranged = updateSessionSelection({
      visibleKeys,
      previous: toggled,
      targetKey: 'e',
      intent: 'range'
    })
    expect(keys(ranged)).toEqual(['c', 'd', 'e'])
    const shrunk = extendSessionSelection({ visibleKeys, previous: ranged, direction: 'up' })
    expect(keys(shrunk)).toEqual(['c', 'd'])
  })

  it('extends with Shift+Down, shrinks back with Shift+Up and crosses the anchor', () => {
    let state = selection(['c'], 'c')
    state = extendSessionSelection({ visibleKeys, previous: state, direction: 'down' })
    state = extendSessionSelection({ visibleKeys, previous: state, direction: 'down' })
    expect(keys(state)).toEqual(['c', 'd', 'e'])
    expect(state.anchor).toBe('c')
    expect(state.focus).toBe('e')
    state = extendSessionSelection({ visibleKeys, previous: state, direction: 'up' })
    expect(keys(state)).toEqual(['c', 'd'])
    state = extendSessionSelection({ visibleKeys, previous: state, direction: 'up' })
    expect(keys(state)).toEqual(['c'])
    expect(state.focus).toBe('c')
    state = extendSessionSelection({ visibleKeys, previous: state, direction: 'up' })
    expect(keys(state)).toEqual(['b', 'c'])
    expect(state.anchor).toBe('c')
    expect(state.focus).toBe('b')
  })

  it('stops at the top and bottom instead of wrapping', () => {
    const bottom = extendSessionSelection({
      visibleKeys,
      previous: selection(['d', 'e'], 'd', 'e'),
      direction: 'down'
    })
    expect(keys(bottom)).toEqual(['d', 'e'])
    expect(bottom.focus).toBe('e')
    const top = extendSessionSelection({
      visibleKeys,
      previous: selection(['a', 'b'], 'b', 'a'),
      direction: 'up'
    })
    expect(keys(top)).toEqual(['a', 'b'])
    expect(top.focus).toBe('a')
  })

  it('starts a selection from the edge when nothing is anchored', () => {
    const down = extendSessionSelection({
      visibleKeys,
      previous: emptySessionSelection(),
      direction: 'down'
    })
    expect(keys(down)).toEqual(['a'])
    const up = extendSessionSelection({
      visibleKeys,
      previous: emptySessionSelection(),
      direction: 'up'
    })
    expect(keys(up)).toEqual(['e'])
    expect(
      extendSessionSelection({
        visibleKeys: [],
        previous: emptySessionSelection(),
        direction: 'down'
      }).selected.size
    ).toBe(0)
  })

  it('steps the focus row with plain arrows and selects only that row', () => {
    const first = stepSessionSelection({
      visibleKeys,
      previous: emptySessionSelection(),
      direction: 'down'
    })
    expect(keys(first)).toEqual(['a'])
    const next = stepSessionSelection({
      visibleKeys,
      previous: selection(['a', 'b', 'c'], 'a', 'c'),
      direction: 'down'
    })
    expect(keys(next)).toEqual(['d'])
    expect(next.anchor).toBe('d')
    const clamped = stepSessionSelection({
      visibleKeys,
      previous: selection(['e'], 'e'),
      direction: 'down'
    })
    expect(keys(clamped)).toEqual(['e'])
  })

  it('selects everything visible with Cmd/Ctrl+A', () => {
    const all = selectAllSessions(visibleKeys)
    expect(keys(all)).toEqual(visibleKeys)
    expect(all.anchor).toBe('a')
    expect(all.focus).toBe('e')
    expect(selectAllSessions([]).selected.size).toBe(0)
  })

  it('prunes to the visible keys when a filter hides selected rows', () => {
    const previous = selection(['a', 'c', 'e'], 'a', 'e')
    const pruned = pruneSessionSelection(previous, ['c', 'd'])
    expect([...pruned.selected]).toEqual(['c'])
    expect(pruned.anchor).toBe('c')
    expect(pruned.focus).toBe('c')
    expect(pruneSessionSelection(previous, visibleKeys)).toBe(previous)
    expect(pruneSessionSelection(previous, []).selected.size).toBe(0)
  })

  it('collapses a range whose anchor left the list onto the clicked row', () => {
    const next = updateSessionSelection({
      visibleKeys: ['b', 'c', 'd'],
      previous: selection(['a'], 'a'),
      targetKey: 'd',
      intent: 'range'
    })
    expect([...next.selected]).toEqual(['d'])
    expect(next.anchor).toBe('d')
  })
})
