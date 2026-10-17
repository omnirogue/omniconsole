import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

// Why: a row's computer name reads in every shipped language, never the English fallback.
const KEYS = [
  ['conversations', 'groupBy', 'thisComputer'],
  ['conversations', 'groupBy', 'unknownComputer'],
  ['sessionHosts', 'rowPairedComputer'],
  ['sessionHosts', 'rowHostTitle'],
  ['sessionHosts', 'openSessionOn']
] as const

function lookup(catalog: object, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    catalog
  )
}

describe('session row computer name locales', () => {
  it.each(KEYS.map((path) => [path.join('.'), path] as const))('translates %s', (_name, path) => {
    const english = lookup(en, path)
    expect(typeof english).toBe('string')
    for (const [locale, catalog] of Object.entries({ es, ja, ko, zh })) {
      const value = lookup(catalog, path)
      expect(typeof value, `${locale} ${path.join('.')}`).toBe('string')
      expect(value, `${locale} ${path.join('.')}`).not.toBe(english)
      for (const placeholder of String(english).match(/\{\{\w+\}\}/g) ?? []) {
        expect(value, `${locale} ${path.join('.')}`).toContain(placeholder)
      }
    }
  })
})
