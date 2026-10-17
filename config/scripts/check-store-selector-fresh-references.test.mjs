import { describe, expect, it } from 'vitest'
import {
  extractPlainStoreSelectors,
  freshReferenceRules,
  returnedExpressions,
  scanSourceForPlainSelectorFreshReferences,
  topLevelSkeleton
} from './check-store-selector-fresh-references.mjs'

const selector = (body) => `const x = useAppStore((state) => ${body})\n`
const rules = (source) =>
  scanSourceForPlainSelectorFreshReferences(source).map((finding) => finding.rule)

describe('check-store-selector-fresh-references', () => {
  it('reads plain selectors and skips useShallow-wrapped ones', () => {
    const source = `${selector('state.tabs')}const y = useAppStore(useShallow((s) => ({ a: s.a })))\n`
    const found = extractPlainStoreSelectors(source)
    expect(found).toHaveLength(1)
    expect(found[0].body).toBe('state.tabs')
    expect(found[0].line).toBe(1)
  })

  it('flags a fresh object or array literal (React #185 without useShallow)', () => {
    expect(rules(selector('({ a: state.a, b: state.b })'))).toEqual([
      'plain-selector-object-literal'
    ])
    expect(rules(selector('[state.a, state.b]'))).toEqual(['plain-selector-array-literal'])
    expect(rules(selector('{ return { a: state.a } }'))).toEqual(['plain-selector-object-literal'])
  })

  it('flags a fresh fallback or a minted collection as the selector result', () => {
    expect(rules(selector('state.tabsByWorktree[id] ?? []'))).toEqual([
      'plain-selector-fresh-fallback'
    ])
    expect(rules(selector('state.items.filter((t) => t.open)'))).toEqual([
      'plain-selector-fresh-call-result'
    ])
    expect(rules(selector('Object.values(state.byId)'))).toEqual([
      'plain-selector-fresh-call-result'
    ])
    expect(rules(selector('state.ready ? [] : state.rows'))).toEqual([
      'plain-selector-fresh-fallback'
    ])
  })

  it('allows stable references, primitives and module-level EMPTY_* fallbacks', () => {
    expect(rules(selector('state.tabs'))).toEqual([])
    expect(rules(selector('state.tabs ?? EMPTY_TABS'))).toEqual([])
    expect(rules(selector('state.tabs.length'))).toEqual([])
    expect(rules(selector('state.items.filter((t) => t.open).length'))).toEqual([])
    expect(rules(selector('state.items.find((t) => t.id === id)'))).toEqual([])
    expect(rules(selector('state.settings?.taskSourcesMode === "all"'))).toEqual([])
  })

  it('does not read a fallback inside a call whose result is a primitive', () => {
    const body = 'resolveKey({ list: state.runtimeEnvironments ?? [], id })'
    expect(topLevelSkeleton(body)).toBe('resolveKey(…)')
    expect(freshReferenceRules(body)).toEqual([])
  })

  it('reads every return of a block body', () => {
    expect(
      returnedExpressions('{ if (!state.a) { return EMPTY }; return state.rows.map((r) => r.id) }')
    ).toEqual(['EMPTY', 'state.rows.map((r) => r.id)'])
  })

  it('honours the opt-out comment on the line or the line above', () => {
    expect(
      rules(`// store-selector-fresh-ref-ok: memoised upstream\n${selector('({ a: state.a })')}`)
    ).toEqual([])
    expect(
      rules(
        `const x = useAppStore((state) => ({ a: state.a })) // store-selector-fresh-ref-ok: test\n`
      )
    ).toEqual([])
  })
})
