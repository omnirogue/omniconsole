import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

/**
 * Extra Council final-check coverage that would make graph-improve-judging.test.ts too long:
 * aggregation under position bias, and the identity check behind decideCouncilFinalCheck (F5).
 */
describe('Council final check: position bias and identity', () => {
  it('aggregates the true majority even though each judge favours whichever it sees first', () => {
    // Presentation rotates per judge (graph-step-calls.ts): with 2 candidates and 3 judges,
    // two see the first opinion first and one sees the chair first. Each judge here always
    // ranks its own first-listed candidate #1 — a pure position-bias vote — yet the aggregated
    // winner must still be the answer two of the three genuinely preferred, not a labelling bug.
    const spec = workflowTemplate('council', ROUTES)
    const firstListedOf = (prompt: string) => prompt.match(/Response ([AB])/)?.[1]
    const seenOrders = new Set<string | undefined>()
    const plan = drive(spec, (call: GraphCall) => {
      if (call.stepId === 'answer') {
        return text(`Opinion ${call.agentIndex}`)
      }
      if (call.stepId === 'chair') {
        return text('Synthesis')
      }
      if (call.round === 1) {
        return text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C')
      }
      if (call.jev) {
        return { ...text('FINAL RANKING:\n1. Response A\n2. Response B'), unsure: true }
      }
      const first = firstListedOf(call.prompt)
      seenOrders.add(first)
      return text(`FINAL RANKING:\n1. Response ${first}\n2. Response ${first === 'A' ? 'B' : 'A'}`)
    })
    expect(seenOrders.size).toBe(2) // both presentation orders were actually used
    expect(plan.runs.chair[0].finalCheck).toEqual({
      result: 'first-opinion',
      judgedBy: ['jev', 'models']
    })
    expect(plan.outcome?.final?.markdown).toMatch(/^Opinion 0\n/)
  })

  it('F5: identifies the defender by role, not by which rotated copy an object reference is', () => {
    // decideImproveRound (reused unmodified) finds the incumbent by object identity in the
    // lineup arrangeImproveLineup returns; since that function returns the very same version
    // objects (never copies), `lineup[decision.index] === defender` is sound in both directions.
    const spec = workflowTemplate('council', ROUTES)
    const plan = drive(spec, (call: GraphCall) => {
      if (call.stepId === 'answer') {
        return text(`Opinion ${call.agentIndex}`)
      }
      if (call.stepId === 'chair') {
        return text('Chair answer')
      }
      if (call.round === 1) {
        return text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C')
      }
      // A sure JEV ballot naming the first opinion (Response A, the defender's position at
      // round two) as the winner: the defender must win by identity, not by coincidence.
      return call.jev ? text('FINAL RANKING:\n1. Response A\n2. Response B') : undefined
    })
    expect(plan.runs.chair[0].finalCheck?.result).toBe('first-opinion')
    expect(plan.outcome?.final?.markdown).toMatch(/^Opinion 0\n/)
  })
})
