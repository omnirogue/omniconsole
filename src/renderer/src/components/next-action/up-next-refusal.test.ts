/**
 * A refused write is said in words.
 *
 * The engine states its rules in TWO catalogs and throws both as the error's message.
 * Reading only the ordering refusals is why a finished session came back as the generic
 * "could not be made on this host" in the chain, and as the raw key in a terminal pane.
 */
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { UP_NEXT_REASON_KEYS, UP_NEXT_REFUSAL_KEYS } from '../../../../shared/up-next-types'
import { upNextDiagnosticText, upNextRefusal, upNextStatedRuleKey } from './up-next-refusal'

describe('up next refusals', () => {
  it('says every rule the engine can state, from both catalogs', () => {
    for (const key of [
      ...Object.values(UP_NEXT_REFUSAL_KEYS),
      ...Object.values(UP_NEXT_REASON_KEYS)
    ]) {
      const said = upNextRefusal(new Error(key))
      expect(said).not.toBe('')
      expect(said).not.toContain('upNext.')
      expect(upNextStatedRuleKey(new Error(key))).toBe(key)
    }
  })

  it('says a closed session is finished instead of blaming the host', () => {
    expect(upNextRefusal(new Error(UP_NEXT_REASON_KEYS.sessionClosed))).toBe(
      en.upNext.addDisabled.sessionClosed
    )
    expect(upNextRefusal(new Error(UP_NEXT_REASON_KEYS.doneLast))).toBe(
      en.upNext.addDisabled.doneLast
    )
  })

  it('says a host sentence the engine threw without stating a catalog rule', () => {
    // Live failure (evidence/na-live-phase1-20260918T043728Z/cli/20g): this sentence
    // arrived as the generic "could not be made on this host" banner instead, because
    // only the two known catalogs were ever read.
    const sentence =
      'This outcome has an in-flight or unverifiable action. Reconcile its receipt before editing.'
    expect(upNextStatedRuleKey(new Error(sentence))).toBeNull()
    expect(upNextRefusal(new Error(sentence))).toBe(sentence)
  })

  it('never lets a raw, unmapped catalog key leak as literal text', () => {
    const unmapped = new Error('upNext.refusal.someFutureRuleThisRendererDoesNotKnowYet')
    expect(upNextStatedRuleKey(unmapped)).toBeNull()
    const said = upNextRefusal(unmapped)
    expect(said).toBe(en.upNext.writeUnavailable)
    expect(said).not.toContain('upNext.')
  })

  it('keeps the generic sentence for empty or missing messages', () => {
    expect(upNextRefusal(new Error('   '))).toBe(en.upNext.writeUnavailable)
    expect(upNextRefusal('not an Error instance')).toBe(en.upNext.writeUnavailable)
  })

  it('says a refusal the host recorded under Details in words, and its own sentence as it is', () => {
    // A held release the engine refused records the rule it stated as the run's diagnostic.
    const said = upNextDiagnosticText(UP_NEXT_REFUSAL_KEYS.needsAgent)
    expect(said).toBe(en.upNext.refusal.needsAgent)
    expect(said).not.toContain('upNext.')
    const sentence = 'Another run of this conversation is in progress.'
    expect(upNextDiagnosticText(sentence)).toBe(sentence)
  })
})
