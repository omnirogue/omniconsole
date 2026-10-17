import { describe, expect, it } from 'vitest'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowRepeat, WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { graphImproveFrontier, graphImproveFrontierSeats } from './graph-improve-frontier'
import type { GraphCall, GraphConfig } from './graph-plan-types'
import { configFor, drive, SEATS, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
const OPUS = {
  ...SEATS[0]!,
  id: 'claude:opus',
  model: 'claude-opus-5-5'
} as ResolvedLocalWorkflowSeat
/** A run admitted with the Claude improver's frontier seat pinned. */
const FRONTIER: Partial<GraphConfig> = {
  seats: [...SEATS, OPUS],
  improveFrontierSeats: ['claude:opus']
}

function improve(repeat: Partial<WorkflowRepeat> = {}): WorkflowSpec {
  const spec = workflowTemplate('improve', ROUTES)
  return { ...spec, repeat: { ...spec.repeat!, ...repeat } }
}

/** Improvers write "v<round>"; JEV ranks by `quality`, a version it does not list last. */
function answer(quality: Record<string, number>) {
  return (call: GraphCall) => {
    if (call.jev) {
      const ordered = [...call.jev.candidates].sort(
        (left, right) => (quality[right.markdown] ?? 0) - (quality[left.markdown] ?? 0)
      )
      return text(
        `FINAL RANKING:\n${ordered.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`
      )
    }
    return call.stepId === 'improve' ? text(`v${call.round}`) : undefined
  }
}

const trailOf = (plan: ReturnType<typeof drive>) => plan.loop!.improve!
const improverCalls = (plan: ReturnType<typeof drive>) =>
  plan.calls.filter((call) => call.stepId === 'improve' && !call.check)

describe('Improve frontier escalation', () => {
  it('moves improvers to their frontier seat after a round without gain, and back after a gain', () => {
    const plan = drive(improve(), answer({ v1: 1, v3: 3 }), FRONTIER)
    const trail = trailOf(plan)
    expect(trail.rounds.map((round) => round.result)).toEqual([
      'first',
      'kept',
      'new-best',
      'kept',
      'kept',
      'kept'
    ])
    expect(trail.rounds.map((round) => !!round.escalated)).toEqual([
      false,
      false,
      true,
      false,
      true,
      true
    ])
    // A frontier call names the seat it ran on, so a replay and the run view credit Opus.
    expect(improverCalls(plan).map((call) => [call.id, call.seatId])).toEqual([
      ['improve/r1/a0', 'claude'],
      ['improve/r2/a0', 'claude'],
      ['improve/r3/f0', 'claude:opus'],
      ['improve/r4/a0', 'claude'],
      ['improve/r5/f0', 'claude:opus'],
      ['improve/r6/f0', 'claude:opus']
    ])
    expect(trail.best).toMatchObject({ round: 3, seatId: 'claude:opus' })
    expect(trail.stop).toBe('plateau')
    expect(plan.outcome?.final?.markdown).toContain('Round 3 · frontier models')
  })

  it('gives frontier models one judged round before a plateau, even when exploring is low', () => {
    const spec = improve({ explore: 'low', patience: 1 })
    const without = trailOf(drive(spec, answer({ v1: 1 })))
    expect(without.rounds.map((round) => round.result)).toEqual(['first', 'kept'])
    expect(without.stop).toBe('plateau')

    const escalated = trailOf(drive(spec, answer({ v1: 1 }), FRONTIER))
    expect(escalated.rounds.map((round) => round.result)).toEqual(['first', 'kept', 'kept'])
    expect(escalated.rounds.map((round) => !!round.escalated)).toEqual([false, false, true])
    expect(escalated.stop).toBe('plateau')

    // With no round left, the search stops as it always did.
    const atLimit = improve({ explore: 'low', patience: 1, maxRounds: 2 })
    const last = trailOf(drive(atLimit, answer({ v1: 1 }), FRONTIER))
    expect(last.rounds.map((round) => round.result)).toEqual(['first', 'kept'])
    expect(last.stop).toBe('plateau')
  })

  it('replays a run admitted without frontier seats exactly as before', () => {
    const before = drive(improve(), answer({ v1: 1, v3: 3 }))
    expect(improverCalls(before).every((call) => call.id.endsWith('/a0'))).toBe(true)
    expect(trailOf(before).rounds.some((round) => round.escalated)).toBe(false)
  })

  it('moves only improvers whose admitted frontier seat differs from their own', () => {
    const spec = improve()
    const step = spec.steps.find((entry) => entry.id === 'improve')!
    const config = { ...configFor(spec), ...FRONTIER }
    expect(graphImproveFrontier(config, step)).toEqual(['claude:opus'])
    expect(graphImproveFrontier(configFor(spec), step)).toBeUndefined()
    const same = { ...config, improveFrontierSeats: ['claude'] }
    expect(graphImproveFrontier(same, step)).toBeUndefined()
    // A seat the run never admitted is never used.
    expect(graphImproveFrontier({ ...config, seats: SEATS }, step)).toBeUndefined()
  })

  it('reads the pinned frontier seats defensively from the snapshot', () => {
    expect(graphImproveFrontierSeats({ graph: { frontierSeats: ['claude:opus'] } })).toEqual({
      improveFrontierSeats: ['claude:opus']
    })
    expect(graphImproveFrontierSeats({ graph: {} })).toEqual({})
    expect(graphImproveFrontierSeats({ graph: { frontierSeats: [1] } })).toEqual({})
  })
})
