import { expect, it } from 'vitest'
import { planReportChain } from './__fixtures__/work-plan/plan-report-chain'
import { sessionOutcomePlanState, sessionOutcomePlanVersion } from './session-outcome-plan-state'
import type { SessionChain } from './session-chain-types'

function withOutcome(
  chain: SessionChain,
  patch: Partial<SessionChain['outcomeSet']>
): SessionChain {
  return { ...chain, outcomeSet: { ...chain.outcomeSet!, ...patch } }
}

it('reads null for a chain with no Outcome and for ordinary work', () => {
  const chain = planReportChain()
  expect(sessionOutcomePlanState({ ...chain, outcomeSet: undefined })).toBeNull()
  expect(
    sessionOutcomePlanState(
      withOutcome(chain, {
        outcomes: chain.outcomeSet!.outcomes.map((outcome) => ({ ...outcome, outputKind: 'work' }))
      })
    )
  ).toBeNull()
})

it('reads planning until every condition of the plan outcome has a receipt', () => {
  const chain = planReportChain()
  // The fixture proves the document but not the person's review: one of two, so still planning.
  expect(sessionOutcomePlanState(chain)).toBe('planning')
  const outcome = chain.outcomeSet!.outcomes[0]!
  const ready = withOutcome(chain, {
    outcomes: [
      {
        ...outcome,
        evidence: [
          ...outcome.evidence,
          {
            ...outcome.evidence[0]!,
            id: 'evidence-review',
            conditionId: 'dw-review',
            conditionKey: 'review:launch',
            kind: 'review',
            target: 'launch',
            receipt: 'review:approved'
          }
        ]
      }
    ]
  })
  expect(sessionOutcomePlanState(ready)).toBe('plan-ready')
})

it('never reads plan-ready from a receipt of an older revision', () => {
  const chain = planReportChain()
  const outcome = chain.outcomeSet!.outcomes[0]!
  const stale = withOutcome(chain, {
    outcomes: [
      {
        ...outcome,
        revision: 2,
        conditions: [outcome.conditions[0]!],
        evidence: outcome.evidence
      }
    ]
  })
  expect(sessionOutcomePlanState(stale)).toBe('planning')
})

it('reads a missing plan version as version 1', () => {
  const chain = planReportChain()
  expect(sessionOutcomePlanVersion(chain)).toBe(1)
  expect(sessionOutcomePlanVersion({ ...chain, planVersion: 3 })).toBe(3)
})
