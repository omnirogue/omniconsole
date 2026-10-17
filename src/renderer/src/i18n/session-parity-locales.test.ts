import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

// Why: a heading's "+N only here (can't verify)" and "+N held by owner" read in every shipped
// language (session parity, step 8), each keeping its count.
const KEYS = [
  ['conversations', 'parity', 'onlyHere'],
  ['conversations', 'parity', 'heldByOwner']
] as const

function lookup(catalog: object, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    catalog
  )
}

describe('session parity heading locales', () => {
  it.each(KEYS.map((path) => [path.join('.'), path] as const))('translates %s', (_name, path) => {
    const english = lookup(en, path)
    expect(typeof english).toBe('string')
    expect(english).toContain('{{count}}')
    for (const [locale, catalog] of Object.entries({ es, ja, ko, zh })) {
      const value = lookup(catalog, path)
      expect(typeof value, `${locale} ${path.join('.')}`).toBe('string')
      expect(value, `${locale} ${path.join('.')}`).not.toBe(english)
      expect(value, `${locale} ${path.join('.')}`).toContain('{{count}}')
    }
  })
})
