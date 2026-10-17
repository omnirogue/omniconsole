import { describe, expect, it } from 'vitest'
import {
  extractUseShallowCallbacks,
  isPrimitiveOnlyArrayLiteral,
  scanSourceForFreshReferences
} from './check-use-shallow-fresh-references.mjs'

function objectSelector(body) {
  return `const x = useAppStore(\n  useShallow((state) => ({\n${body}\n  }))\n)\n`
}

function rawSelector(body) {
  return `const x = useAppStore(\n  useShallow((state) =>\n${body}\n  )\n)\n`
}

const rules = (source) => scanSourceForFreshReferences(source).map((finding) => finding.rule)

describe('check-use-shallow-fresh-references', () => {
  it('extracts the callback body and its line', () => {
    const callbacks = extractUseShallowCallbacks(objectSelector('    tabs: state.tabs'))
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0].line).toBe(2)
    expect(callbacks[0].body).toContain('tabs: state.tabs')
  })

  it('flags nested `?? []` and `?? {}` fallbacks (the Attention page React #185 shape)', () => {
    expect(rules(objectSelector('    tabs: state.tabsByWorktree[id] ?? []'))).toEqual([
      'nested-fallback-empty-array'
    ])
    expect(rules(objectSelector('    layouts: state.layouts ?? {}'))).toEqual([
      'nested-fallback-empty-object'
    ])
    expect(rules('useAppStore(useShallow((s) => ({ tabs: s.tabs ?? [] })))')).toEqual([
      'nested-fallback-empty-array'
    ])
  })

  it('flags nested .map, .filter and Object.values/keys/entries', () => {
    expect(rules(objectSelector('    ids: state.tabs.map((tab) => tab.id)'))).toEqual([
      'nested-map-call'
    ])
    expect(rules(objectSelector('    busy: state.tabs.filter((tab) => tab.busy)'))).toEqual([
      'nested-filter-call'
    ])
    expect(rules(objectSelector('    all: Object.values(state.byId)'))).toEqual([
      'nested-object-values'
    ])
    expect(rules(objectSelector('    keys: Object.keys(state.byId)'))).toEqual([
      'nested-object-values'
    ])
    expect(rules(objectSelector('    pairs: Object.entries(state.byId)'))).toEqual([
      'nested-object-values'
    ])
  })

  it('flags nested calls that continue on the next line', () => {
    expect(
      rules(
        objectSelector(
          '    ids: state.tabs\n      .filter((tab) => tab.busy)\n      .map((tab) => tab.id),\n    other: state.other'
        )
      )
    ).toEqual(['nested-filter-call', 'nested-map-call'])
  })

  it('flags nested object and array literals, even primitive-only arrays', () => {
    expect(rules(objectSelector('    pane: { id: state.activeId }'))).toEqual([
      'nested-object-literal'
    ])
    expect(rules(objectSelector('    pair: [state.a, state.b]'))).toEqual(['nested-array-literal'])
    expect(rules(objectSelector('    layout: active ? state.layout : {}'))).toEqual([
      'nested-object-literal'
    ])
  })

  it('allows nested module-level EMPTY_* fallbacks', () => {
    expect(rules(objectSelector('    tabs: state.tabsByWorktree[id] ?? EMPTY_TABS'))).toEqual([])
    expect(rules(objectSelector('    layouts: state.layouts ?? EMPTY_LAYOUTS_BY_ID,'))).toEqual([])
  })

  it('allows top-level fresh iterables of stable members (what useShallow compares)', () => {
    expect(rules(rawSelector('    state.tabs.map((tab) => tab.id)'))).toEqual([])
    expect(
      rules(rawSelector('    Object.values(state.byId).filter((entry) => entry.live)'))
    ).toEqual([])
    expect(rules(rawSelector('    active ? selectRows(state, id) : []'))).toEqual([])
    expect(rules(rawSelector('    active ? selectRows(state, id) : {}'))).toEqual([])
    expect(rules(rawSelector('    [state.activeWorktreeId, state.activeTabId, 3, "x"]'))).toEqual(
      []
    )
  })

  it('flags top-level maps that mint fresh object elements', () => {
    expect(rules(rawSelector('    state.tabs.map((tab) => ({ id: tab.id }))'))).toEqual([
      'map-with-fresh-object-elements'
    ])
    expect(rules(rawSelector('    [{ id: state.activeId }]'))).toEqual([
      'array-literal-with-fresh-elements'
    ])
  })

  it('honours the opt-out comment on the line or the line above', () => {
    expect(
      rules(
        objectSelector(
          '    ids: state.tabs.map((tab) => tab.id) // useShallow-fresh-ref-ok: memoised upstream'
        )
      )
    ).toEqual([])
    expect(
      rules(
        objectSelector(
          '    // useShallow-fresh-ref-ok: slice is frozen\n    all: Object.values(state.byId)'
        )
      )
    ).toEqual([])
  })

  it('ignores code outside useShallow callbacks and type annotations', () => {
    expect(rules('const a = list.map((x) => x)\nconst b = { tabs: state.tabs ?? [] }\n')).toEqual(
      []
    )
    expect(rules(objectSelector('    tabs: state.tabs as readonly Tab[]'))).toEqual([])
  })

  it('handles several selectors in one file', () => {
    const source = objectSelector('    a: state.a ?? []') + objectSelector('    b: state.b')
    expect(scanSourceForFreshReferences(source)).toHaveLength(1)
  })

  it('classifies primitive-only array literals', () => {
    expect(isPrimitiveOnlyArrayLiteral('[]')).toBe(true)
    expect(isPrimitiveOnlyArrayLiteral('[state.a, 1, "x", null]')).toBe(true)
    expect(isPrimitiveOnlyArrayLiteral('[{ a: 1 }]')).toBe(false)
    expect(isPrimitiveOnlyArrayLiteral('[state.list.map((x) => x)]')).toBe(false)
  })
})
