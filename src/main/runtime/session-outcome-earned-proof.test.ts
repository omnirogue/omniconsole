import { describe, expect, it } from 'vitest'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet
} from '../../shared/session-outcome-types'
import { runDefinition, runSet } from '../../shared/session-run-lifecycle.test-fixture'
import { restoreEarnedSourceReceipt } from './session-outcome-earned-proof'

const VERSION = 'b'.repeat(64)
const session = { id: 'source', kind: 'session', target: 'tab:leaf' } as const

/** A run whose source reading is held, with the source receipt an older host retired to history. */
function stranded(
  overrides: { continuation?: Partial<SessionOutcomeSet['continuation']> } = {},
  receipt: Partial<SessionOutcomeEvidence> = {}
): { set: SessionOutcomeSet; earned: SessionOutcomeEvidence } {
  const set = runSet([runDefinition('one', { conditions: [session] })])
  const outcome = set.outcomes[0]!
  const earned: SessionOutcomeEvidence = {
    id: 'receipt_source',
    outcomeId: 'one',
    outcomeRevision: outcome.revision,
    conditionId: session.id,
    conditionKey: sessionOutcomeConditionKey(outcome.conditions[0]!),
    kind: 'session',
    target: session.target,
    version: VERSION,
    receipt: `session:${session.target}:${VERSION}`,
    verifiedAt: 2,
    verifier: 'execution-host',
    ...receipt
  }
  return {
    earned,
    set: {
      ...set,
      continuation: {
        ...set.continuation,
        sourceReady: true,
        sourceVersion: VERSION,
        ...overrides.continuation
      },
      evidenceHistory: [earned]
    }
  }
}

const restored = (set: SessionOutcomeSet) =>
  restoreEarnedSourceReceipt(set, 'one', set.outcomes[0]!.conditions[0]!).outcomes[0]!.evidence

describe('putting back a source receipt that lost contact retired', () => {
  it('restores the very receipt that was earned: same id, same time, nothing minted', () => {
    const { set, earned } = stranded()
    expect(restored(set)).toEqual([earned])
  })

  it('takes the newest of several, and does nothing when the receipt is already held', () => {
    const { set, earned } = stranded()
    const newer = { ...earned, id: 'receipt_newer', verifiedAt: 9 }
    const twice = { ...set, evidenceHistory: [earned, newer] }
    expect(restored(twice)).toEqual([newer])
    const held = restoreEarnedSourceReceipt(twice, 'one', twice.outcomes[0]!.conditions[0]!)
    expect(restoreEarnedSourceReceipt(held, 'one', held.outcomes[0]!.conditions[0]!)).toBe(held)
  })

  it.each([
    ['an older outcome revision', {}, { outcomeRevision: 7 }],
    ['another condition', {}, { conditionId: 'other' }],
    ['a condition that has since been restated', {}, { conditionKey: 'restated' }],
    ['a source reading the run no longer holds', { sourceVersion: 'c'.repeat(64) }, {}],
    ['a run whose finish commit re-bound the source', { sourceReady: false }, {}]
  ])('never restores a receipt of %s', (_name, continuation, receipt) => {
    const { set } = stranded({ continuation }, receipt)
    expect(restored(set)).toEqual([])
  })
})
