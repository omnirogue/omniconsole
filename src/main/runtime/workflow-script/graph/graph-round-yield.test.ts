import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { configFor, drive, task, text } from './graph-test-harness'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'

function spec(k?: number, limit = 10) {
  return normalizeWorkflowSpec({
    template: 'discover',
    title: 'Yield',
    steps: [
      {
        id: 'find',
        title: 'Find',
        kind: 'do',
        agents: [{ route: 'claude' }],
        list: { maxItems: 10 }
      },
      {
        id: 'verify',
        title: 'Verify',
        kind: 'review',
        agents: [{ route: 'codex' }],
        inputs: ['find'],
        forEach: { step: 'find', limit }
      },
      {
        id: 'report',
        title: 'Report',
        kind: 'synthesize',
        agents: [{ route: 'claude' }],
        inputs: ['verify']
      }
    ],
    repeat: {
      do: 'find',
      review: 'verify',
      until: 'nothing-new',
      maxRounds: 2,
      minConfirmedForRound2: k
    }
  })
}
const answer = (call: GraphCall) =>
  call.stepId === 'find'
    ? {
        items: [
          {
            title: `Claim ${call.round}`,
            detail: 'Concrete evidence and proposed fix.',
            location: `${call.round}.ts:1`,
            severity: 'high'
          }
        ]
      }
    : text(call.stepId === 'verify' ? 'VERDICT: PASS\nBacked by the source.' : 'Report')

describe('23: optional round-two yield gate', () => {
  it('is off by default, skips below k and runs at the threshold', () => {
    expect(spec().repeat).not.toHaveProperty('minConfirmedForRound2')
    expect(spec(0).repeat).not.toHaveProperty('minConfirmedForRound2')
    expect(drive(spec(), answer).runs.find).toHaveLength(2)
    const skipped = drive(spec(2), answer)
    expect(skipped.runs.find).toHaveLength(1)
    expect(skipped.notes.join(' ')).toContain('Skipped round 2')
    expect(drive(spec(1), answer).runs.find).toHaveLength(2)
  })
  it('waits for the first review before scheduling round two', () => {
    const workflow = spec(2),
      config = configFor(workflow)
    const outcomes = new Map<string, GraphOutcome>()
    const initial = planWorkflowGraph(config, task, outcomes)
    for (const call of initial.ready) {
      outcomes.set(call.id, { value: answer(call) })
    }
    const reviewing = planWorkflowGraph(config, task, outcomes)
    expect(reviewing.ready.some((call) => call.stepId === 'verify')).toBe(true)
    expect(reviewing.ready.some((call) => call.stepId === 'find' && call.round === 2)).toBe(false)
  })
  it('preserves another round when review failed or a budget left unchecked overflow', () => {
    expect(
      drive(spec(2), (call) => (call.stepId === 'verify' ? undefined : answer(call))).runs.find
    ).toHaveLength(2)
    const workflow = spec(3, 1)
    const plan = drive(workflow, (call) =>
      call.stepId === 'find'
        ? {
            items: [
              {
                title: `First ${call.round}`,
                detail: 'Concrete first claim with evidence.',
                location: 'a.ts:1',
                severity: 'high'
              },
              {
                title: `Second ${call.round}`,
                detail: 'Different second claim with evidence.',
                location: 'b.ts:2',
                severity: 'high'
              }
            ]
          }
        : answer(call)
    )
    expect(plan.runs.find).toHaveLength(2)
  })
})
