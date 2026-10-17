import { describe, expect, it } from 'vitest'
import {
  decodeSidebarLayout,
  EMPTY_SIDEBAR_LAYOUT,
  hiddenEntries,
  insert,
  isDefaultLayout,
  isHidden,
  moveBy,
  orderedIds,
  place,
  withAppliedView,
  withHidden,
  withOrder,
  withoutHidden,
  withoutSavedView,
  withSavedView,
  activeViewIsDirty
} from './sidebar-layout'

describe('a saved order is partial', () => {
  it('lays the saved ids first and appends anything new at its default rank', () => {
    expect(orderedIds(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('evaporates an id that no longer exists, with no migration', () => {
    expect(orderedIds(['a', 'b'], ['gone', 'b', 'a'])).toEqual(['b', 'a'])
  })

  it('keeps the built-in order when nothing was saved', () => {
    expect(orderedIds(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('ignores a repeated id in a saved order rather than drawing it twice', () => {
    expect(orderedIds(['a', 'b'], ['b', 'b', 'a'])).toEqual(['b', 'a'])
  })
})

describe('moving a row within its group', () => {
  it('places a row before or after its target', () => {
    expect(place(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(place(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
  })

  it('does nothing when a row is dropped on itself', () => {
    expect(place(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b'])
  })

  it('does nothing when either id is not in this group', () => {
    expect(place(['a', 'b'], 'z', 'a', 'before')).toEqual(['a', 'b'])
    expect(place(['a', 'b'], 'a', 'z', 'before')).toEqual(['a', 'b'])
  })

  it('moves one step for the keyboard and stops at the ends', () => {
    expect(moveBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('a row arriving from another group', () => {
  it('lands exactly where it was dropped, not appended', () => {
    expect(insert(['a', 'b', 'c'], 'z', 'b', 'before')).toEqual(['a', 'z', 'b', 'c'])
    expect(insert(['a', 'b', 'c'], 'z', 'b', 'after')).toEqual(['a', 'b', 'z', 'c'])
  })

  it('appends when there is no target to land beside', () => {
    expect(insert([], 'z', null, 'before')).toEqual(['z'])
    expect(insert(['a'], 'z', null, 'after')).toEqual(['a', 'z'])
  })

  it('drops a stale copy first, so a round trip never leaves two', () => {
    expect(insert(['a', 'z', 'b'], 'z', 'a', 'before')).toEqual(['z', 'a', 'b'])
  })
})

describe('hiding is a preference, never a loss', () => {
  it('records the label alongside the id so the restore list can name it', () => {
    const layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'nav:agents', 'Agents')
    expect(isHidden(layout, 'nav:agents')).toBe(true)
    expect(hiddenEntries(layout)).toEqual([{ id: 'nav:agents', label: 'Agents' }])
    expect(isHidden(withoutHidden(layout, 'nav:agents'), 'nav:agents')).toBe(false)
  })

  it('knows an untouched layout from an arranged one, so Reset can say so', () => {
    expect(isDefaultLayout(EMPTY_SIDEBAR_LAYOUT)).toBe(true)
    expect(isDefaultLayout(withOrder(EMPTY_SIDEBAR_LAYOUT, 'nav', ['b', 'a']))).toBe(false)
    expect(isDefaultLayout(withHidden(EMPTY_SIDEBAR_LAYOUT, 'x', 'X'))).toBe(false)
  })

  it('never mutates the layout it was given', () => {
    const before = withOrder(EMPTY_SIDEBAR_LAYOUT, 'nav', ['a'])
    withHidden(before, 'a', 'A')
    expect(before.hidden).toEqual({})
  })
})

describe('decoding is total', () => {
  it('yields a usable layout from anything, rather than throwing', () => {
    for (const value of [null, undefined, 7, 'text', [], { orders: 1, hidden: 'no' }]) {
      expect(decodeSidebarLayout(value)).toEqual(EMPTY_SIDEBAR_LAYOUT)
    }
  })

  it('keeps what it can read and drops what it cannot', () => {
    const layout = decodeSidebarLayout({
      orders: { nav: ['a', 'b', 'a', 7, ''], broken: 'not a list', '': ['x'] },
      hidden: { 'nav:agents': 'Agents', bad: 9, '': 'blank' },
      stray: true
    })
    // Duplicates and non-strings go; the scope with no name goes with them.
    expect(layout.orders).toEqual({ nav: ['a', 'b'] })
    expect(layout.views).toEqual([])
    expect(layout.hidden).toEqual({ 'nav:agents': 'Agents' })
  })

  it('drops an empty order rather than saving a scope that says nothing', () => {
    expect(decodeSidebarLayout({ orders: { nav: [] } }).orders).toEqual({})
  })

  it('round-trips a layout it produced', () => {
    const layout = withHidden(withOrder(EMPTY_SIDEBAR_LAYOUT, 'nav', ['b', 'a']), 'x', 'X')
    expect(decodeSidebarLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
  })
})

describe('a persisted layout is untrusted input', () => {
  it('drops a prototype-shaped key wherever it arrives', () => {
    const layout = decodeSidebarLayout({
      orders: { __proto__: ['a'], constructor: ['b'], prototype: ['c'], nav: ['__proto__', 'a'] },
      hidden: { __proto__: 'X', constructor: 'Y', 'nav:agents': 'Agents' }
    })
    expect(Object.keys(layout.orders)).toEqual(['nav'])
    // The id inside a scope is filtered too, not just the scope name.
    expect(layout.orders.nav).toEqual(['a'])
    expect(Object.keys(layout.hidden)).toEqual(['nav:agents'])
    expect(Object.getPrototypeOf(layout.orders)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).X).toBeUndefined()
  })

  it('refuses to write a key the decode would drop', () => {
    const planted = withOrder(EMPTY_SIDEBAR_LAYOUT, '__proto__', ['a'])
    expect(Object.keys(planted.orders)).toEqual([])
    const hid = withHidden(EMPTY_SIDEBAR_LAYOUT, 'constructor', 'C')
    expect(Object.keys(hid.hidden)).toEqual([])
  })

  it('caps a grown file so the sidebar cannot become the slowest thing on screen', () => {
    const orders: Record<string, string[]> = {}
    for (let i = 0; i < 400; i += 1) {
      orders[`scope-${i}`] = [`a-${i}`]
    }
    const hidden: Record<string, string> = {}
    for (let i = 0; i < 2000; i += 1) {
      hidden[`row-${i}`] = 'R'
    }
    const layout = decodeSidebarLayout({
      orders: { ...orders, wide: Array.from({ length: 900 }, (_, i) => `id-${i}`) },
      hidden
    })
    expect(Object.keys(layout.orders).length).toBeLessThanOrEqual(200)
    expect(Object.keys(layout.hidden).length).toBeLessThanOrEqual(1000)
    const wide = layout.orders.wide
    if (wide) {
      expect(wide.length).toBeLessThanOrEqual(500)
    }
  })

  it('truncates a label rather than carrying an unbounded string', () => {
    const layout = withHidden(EMPTY_SIDEBAR_LAYOUT, 'row', 'x'.repeat(5000))
    expect(layout.hidden.row.length).toBeLessThanOrEqual(200)
  })

  it('keeps a long but legitimate key, and drops an absurd one', () => {
    const long = `company:${'a'.repeat(100)}/domains`
    expect(Object.keys(decodeSidebarLayout({ orders: { [long]: ['a'] } }).orders)).toEqual([long])
    expect(decodeSidebarLayout({ orders: { ['a'.repeat(900)]: ['a'] } }).orders).toEqual({})
  })
})

describe('saved arrangements', () => {
  const arranged = withHidden(withOrder(EMPTY_SIDEBAR_LAYOUT, 'nav', ['b', 'a']), 'x', 'X')

  it('saves a full snapshot, not a patch on the live one', () => {
    const saved = withSavedView(arranged, 'v1', 'Focus')
    expect(saved.views).toHaveLength(1)
    expect(saved.views[0]).toMatchObject({
      id: 'v1',
      name: 'Focus',
      orders: { nav: ['b', 'a'] },
      hidden: { x: 'X' }
    })
    expect(saved.activeView).toBe('v1')
  })

  it('restores the whole arrangement when applied, replacing the live one', () => {
    const saved = withSavedView(arranged, 'v1', 'Focus')
    const moved = withHidden(withOrder(saved, 'nav', ['a', 'b']), 'y', 'Y')
    const back = withAppliedView(moved, 'v1')
    expect(back.orders).toEqual({ nav: ['b', 'a'] })
    expect(back.hidden).toEqual({ x: 'X' })
    // The view list itself is untouched by applying one.
    expect(back.views).toHaveLength(1)
  })

  it('updates an arrangement saved under a name already used, rather than adding a twin', () => {
    const first = withSavedView(arranged, 'v1', 'Focus')
    const changed = withOrder(first, 'nav', ['a', 'b'])
    const again = withSavedView(changed, 'v2', 'focus')
    // Case-insensitive: "Focus" and "focus" are one arrangement to a reader.
    expect(again.views).toHaveLength(1)
    expect(again.views[0].id).toBe('v1')
    expect(again.views[0].orders).toEqual({ nav: ['a', 'b'] })
  })

  it('marks an applied arrangement as changed once the live one moves', () => {
    const saved = withSavedView(arranged, 'v1', 'Focus')
    expect(activeViewIsDirty(saved)).toBe(false)
    expect(activeViewIsDirty(withOrder(saved, 'nav', ['a', 'b']))).toBe(true)
    // Nothing applied means nothing to be dirty about.
    expect(activeViewIsDirty(arranged)).toBe(false)
  })

  it('forgets an arrangement and stops calling it applied', () => {
    const saved = withSavedView(arranged, 'v1', 'Focus')
    const gone = withoutSavedView(saved, 'v1')
    expect(gone.views).toEqual([])
    expect(gone.activeView).toBeNull()
  })

  it('refuses a nameless arrangement and a prototype-shaped id', () => {
    expect(withSavedView(arranged, 'v1', '   ').views).toEqual([])
    expect(withSavedView(arranged, '__proto__', 'Focus').views).toEqual([])
  })

  it('decodes saved arrangements by the same rules as the live one', () => {
    const layout = decodeSidebarLayout({
      orders: { nav: ['a'] },
      hidden: {},
      views: [
        {
          id: 'v1',
          name: 'Focus',
          orders: { nav: ['b', 'a', 'b'], __proto__: ['z'] },
          hidden: { x: 'X' }
        },
        { id: '', name: 'No id', orders: {}, hidden: {} },
        { id: 'v2', name: '   ', orders: {}, hidden: {} },
        { id: 'v1', name: 'Duplicate id', orders: {}, hidden: {} },
        'not an object'
      ],
      activeView: 'v1'
    })
    expect(layout.views).toHaveLength(1)
    expect(layout.views[0].orders).toEqual({ nav: ['b', 'a'] })
    expect(layout.activeView).toBe('v1')
  })

  it('applies nothing when the active arrangement no longer exists', () => {
    expect(decodeSidebarLayout({ views: [], activeView: 'gone' }).activeView).toBeNull()
  })

  it('does not count saved arrangements as drift from the default', () => {
    // Reset must stay offered to somebody who has arrangements but no live changes.
    const onlyViews = {
      ...EMPTY_SIDEBAR_LAYOUT,
      views: [{ id: 'v1', name: 'F', orders: {}, hidden: {} }]
    }
    expect(isDefaultLayout(onlyViews)).toBe(true)
  })
})
