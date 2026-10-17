import { expect, it } from 'vitest'
import { recommendNextTransforms, type WorkPlanRecommendationState } from './work-plan-recommend'
import { samWorkPlan } from './__fixtures__/work-plan/wp2/example-work-plan'
import type { WorkPlanRole } from './work-plan-types'
const outcome = { ...samWorkPlan().outcome, revision: 3 }
function state(
  role: WorkPlanRole,
  patch: Partial<WorkPlanRecommendationState['lastStage']> = {}
): WorkPlanRecommendationState {
  return {
    outcomeRevision: 3,
    unsatisfiedDoneWhen: ['dw-copy'],
    lastStage: {
      role,
      outputContract: 'result',
      candidateCount: 1,
      settled: 'completed',
      ...patch
    },
    planVersion: 1,
    attemptStates: ['completed']
  }
}
const ids = (s: WorkPlanRecommendationState, o = outcome) =>
  recommendNextTransforms(s, o).map((r) => r.id)
it.each(['implement', 'improve', 'repair'] as const)(
  '%s recommends verification before more work',
  (role) => {
    expect(ids(state(role))).toEqual(['verify', 'review', 'test', 'analyze', 'improve', 'plan'])
  }
)
it.each(['research', 'analyze', 'summarize'] as const)(
  '%s synthesizes multiple findings, otherwise plans',
  (role) => {
    expect(ids(state(role, { candidateCount: 3, outputContract: 'reports' }))).toEqual([
      'synthesize',
      'plan',
      'give-to'
    ])
    expect(ids(state(role))).toEqual(['plan', 'give-to'])
  }
)
it('ranks candidate plans or implementations with a judge first', () => {
  expect(ids(state('plan', { candidateCount: 3, outputContract: 'candidates' }))).toEqual([
    'judge',
    'synthesize',
    'review'
  ])
})
it('repairs findings or a fail with retry remaining', () => {
  expect(ids(state('review', { verdict: { status: 'findings' } }))).toEqual(['improve', 'verify'])
  expect(
    ids({ ...state('verify', { verdict: { status: 'fail' } }), attemptStates: ['retryable'] })
  ).toEqual(['improve', 'verify'])
})
it('offers Done only when every criterion passed at the current revision', () => {
  expect(
    ids({ ...state('verify', { verdict: { status: 'pass' } }), unsatisfiedDoneWhen: [] })
  ).toEqual(['done'])
  expect(
    ids({
      ...state('verify', { verdict: { status: 'pass' } }),
      outcomeRevision: 2,
      unsatisfiedDoneWhen: []
    })
  ).not.toContain('done')
})
it('reviews a plan and offers implementation only for work outcomes', () => {
  expect(ids(state('plan'), { ...outcome, outputKind: 'plan' })).toEqual(['review', 'give-to'])
  expect(ids(state('plan'))).toEqual(['review', 'implement', 'give-to'])
})
it('puts Define Done When first when none is stated', () => {
  expect(ids(state('implement'), { ...outcome, doneWhen: [] })[0]).toBe('define-done-when')
})
it.each(['blocked', 'failed', 'superseded'] as const)(
  '%s proposes the next strategy from failure and unsatisfied criteria',
  (settled) => {
    const s = state('verify', { settled, blockedReason: 'No price in page' })
    expect(ids(s)).toEqual(['change-strategy', 'retry-seat', 'ask-me'])
    expect(recommendNextTransforms(s, outcome)[0]).toMatchObject({
      planVersion: 2,
      outcomeRevision: 3,
      instruction: expect.stringContaining('No price in page')
    })
    expect(recommendNextTransforms(s, outcome)[0]!.instruction).toContain(
      'the page states the offer and the price'
    )
  }
)
it('a failed verdict without retry changes strategy; active work hides the action', () => {
  const s = state('verify', { verdict: { status: 'fail', blockingFindings: ['price absent'] } })
  expect(ids(s)).toEqual(['change-strategy', 'retry-seat', 'ask-me'])
  expect(ids({ ...s, attemptStates: ['running'] })).toEqual(['ask-me'])
})
it('all recommendations are outcome-relative and pure', () => {
  const s = state('implement')
  const before = structuredClone(s)
  const first = recommendNextTransforms(s, outcome)
  expect(first.every((r) => r.instruction.includes(outcome.title))).toBe(true)
  expect(recommendNextTransforms(s, outcome)).toEqual(first)
  expect(s).toEqual(before)
})
