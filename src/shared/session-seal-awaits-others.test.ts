import { describe, expect, it } from 'vitest'
import type { SessionChain } from './session-chain-types'
import { sessionSealAwaitsOthers } from './session-seal-awaits-others'
import { sessionOutcomeConditionKey } from './session-outcome-types'

type Condition = {
  id: string
  kind: 'pr' | 'handoff' | 'review' | 'file' | 'session'
  target: string
}

function sealed(conditions: Condition[], receipts: string[], seal = true): SessionChain {
  const outcome = {
    id: 'outcome',
    revision: 1,
    conditions,
    evidence: receipts.map((receipt, index) => {
      const condition = conditions[index]!
      return {
        id: `evidence_${index}`,
        outcomeId: 'outcome',
        outcomeRevision: 1,
        conditionId: condition.id,
        conditionKey: sessionOutcomeConditionKey(condition),
        kind: condition.kind,
        target: condition.target,
        receipt,
        verifiedAt: 5,
        verifier: 'execution-host'
      }
    })
  }
  return {
    outcomeSet: {
      outcomes: [outcome],
      ...(seal
        ? { completion: { at: 10, outcomes: [{ id: 'outcome', revision: 1 }], evidenceIds: [] } }
        : {})
    }
  } as unknown as SessionChain
}

describe('sessionSealAwaitsOthers', () => {
  it('names the merge a sealed PR receipt has not reached', () => {
    const pr: Condition = { id: 'pr', kind: 'pr', target: 'https://github.com/x/y/pull/1' }
    expect(sessionSealAwaitsOthers(sealed([pr], ['pr:1:open']))).toBe('merge')
    expect(sessionSealAwaitsOthers(sealed([pr], ['pr:1:merged']))).toBeNull()
    // Why: no receipt at all is unproven, not a wait; the row is Done, finished.
    expect(sessionSealAwaitsOthers(sealed([pr], []))).toBeNull()
  })
  it('names a handoff whose recipient still has the work', () => {
    const handoff: Condition = { id: 'handoff', kind: 'handoff', target: 'hth_12345678' }
    const turn: Condition = { id: 'turn', kind: 'session', target: 'source' }
    expect(sessionSealAwaitsOthers(sealed([handoff], []))).toBe('handoff')
    expect(sessionSealAwaitsOthers(sealed([handoff, turn], []))).toBe('handoff')
    const file: Condition = { id: 'file', kind: 'file', target: '/out.txt' }
    expect(sessionSealAwaitsOthers(sealed([handoff, file], []))).toBeNull()
    expect(sessionSealAwaitsOthers(sealed([turn], []))).toBeNull()
  })
  it("names a reviewer's request for changes, never the owner's own review", () => {
    const review: Condition = { id: 'review', kind: 'review', target: 'review' }
    expect(
      sessionSealAwaitsOthers(sealed([review], ['handoff-review:hth_1:review_1:request_changes']))
    ).toBe('review')
    expect(
      sessionSealAwaitsOthers(sealed([review], ['handoff-review:hth_1:review_1:approve']))
    ).toBeNull()
    expect(sessionSealAwaitsOthers(sealed([review], ['done-for-review:v1']))).toBeNull()
    expect(sessionSealAwaitsOthers(sealed([review], ['user-review:v1']))).toBeNull()
  })
  it('answers nothing for a run that is not sealed', () => {
    const pr: Condition = { id: 'pr', kind: 'pr', target: 'https://github.com/x/y/pull/1' }
    expect(sessionSealAwaitsOthers(sealed([pr], ['pr:1:open'], false))).toBeNull()
    expect(sessionSealAwaitsOthers({} as SessionChain)).toBeNull()
  })
})
