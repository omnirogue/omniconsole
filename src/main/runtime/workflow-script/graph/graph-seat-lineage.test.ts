import { describe, expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { graphFirstReview, graphReviewTally } from './graph-first-reviewer'
import { createGraphScope } from './graph-scope'
import { configFor, task } from './graph-test-harness'
import type { GraphItem } from './graph-items'
import type { GraphCall, GraphOutcome } from './graph-plan-types'

function fixture() {
  const config = configFor(workflowTemplate('discover', ['claude', 'codex', 'grok']))
  const outcomes = new Map<string, GraphOutcome>()
  const scope = createGraphScope(config, task, outcomes)
  const step = config.spec.steps.find((step) => step.id === 'verify')!
  const item: GraphItem = {
    key: 'find.r1.1',
    title: 'lost result',
    detail: 'An interrupted call loses its result',
    severity: 'high',
    location: 'a.ts:1',
    round: 1,
    sourceCallId: 'find/r1/a0',
    repeats: 0
  }
  return { config, outcomes, scope, step, item }
}

describe('actual substitute model lineage', () => {
  it('selects a reviewer independent of the substituted finder', () => {
    const f = fixture()
    f.outcomes.set(f.item.sourceCallId, {
      value: {},
      substitute: {
        seatId: 'codex',
        callId: 'find/r1/a0~codex',
        from: 'Claude',
        to: 'Codex',
        reason: 'limited'
      }
    })
    const review = graphFirstReview(f.scope, f.step, f.item)
    expect(f.config.agentSeats.verify[review.index]).not.toBe('codex')
    expect(review.independent).toBe(true)
  })

  it('does not confirm when the independent reviewer substituted back to the finder family', () => {
    const f = fixture()
    const reviewer = f.config.agentSeats.verify.indexOf('codex')
    const earlier = `verify/r1/${f.item.key}/a${reviewer}`
    f.scope.calls.push({ id: earlier, stepId: 'verify', agentIndex: reviewer } as GraphCall)
    f.outcomes.set(earlier, { value: {} })
    const id = `verify/r2/${f.item.key}/a${reviewer}`
    f.scope.calls.push({ id, stepId: 'verify', agentIndex: reviewer } as GraphCall)
    f.outcomes.set(id, {
      value: {},
      substitute: {
        seatId: 'claude',
        callId: `${id}~claude`,
        from: 'Codex',
        to: 'Claude',
        reason: 'limited'
      }
    })
    expect(graphReviewTally(f.scope, f.step, f.item, ['pass'], [reviewer])).toEqual({
      tally: 'unverified',
      sameFamilyOnly: true
    })
  })
})
