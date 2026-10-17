import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

// Why: a paired owner's rows and its ledger state read in every shipped language (session parity,
// step 6); the owner sends only the agent's name, so "(untitled)" is this computer's to translate.
// Step 7's activation and delete answers read there too, and "Open it on <Computer>" is also why a
// ledger-only row's actions are off (E1/F13).
const KEYS = [
  ['conversations', 'ledger', 'untitled'],
  ['conversations', 'ledger', 'pausedOn'],
  ['conversations', 'ledger', 'stoppedOn'],
  ['conversations', 'mirroredConversationResumeOn'],
  ['conversations', 'mirroredConversationOpenOn'],
  ['conversations', 'mirroredConversationDeleteOn'],
  ['conversations', 'mirroredConversationDeleteOnOwners'],
  ['conversations', 'mirroredConversationDeleteRefused'],
  ['conversations', 'mirroredConversationDeleteRefusedMany'],
  ['sessionHosts', 'ledgerOlder'],
  ['sessionHosts', 'ledgerLastList'],
  ['sessionHosts', 'ledgerStale'],
  ['sessionHosts', 'ledgerUnreachable']
] as const

function lookup(catalog: object, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    catalog
  )
}

describe('paired owner ledger locales', () => {
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
