import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { decideImproveRound, type ImproveVersion } from './graph-improve-decide'
import { IMPROVE_RULES } from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

const RULES_3: Partial<GraphConfig> = { improveRules: IMPROVE_RULES }
const CHALLENGER_FIRST = 'FINAL RANKING:\n1. Response B\n2. Response A'

/** Claude improves; one model judge of `judge`'s family stands in when JEV cannot decide. */
function improve(judge: WorkflowRoute): WorkflowSpec {
  return {
    version: 1,
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: [{ route: 'claude' }],
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: [{ route: judge }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: 2,
      patience: 2,
      explore: 'low'
    }
  }
}

/** Round 2 shows the best version as Response A and the challenger as B. */
function answer(jev: 'fails' | 'prefers-challenger') {
  return (call: GraphCall): unknown => {
    if (call.jev) {
      return jev === 'fails' ? undefined : text(CHALLENGER_FIRST)
    }
    return call.stepId === 'judge' ? text(CHALLENGER_FIRST) : text(`v${call.round}`)
  }
}

const roundTwo = (plan: ReturnType<typeof drive>) => plan.loop!.improve!.rounds[1]!

describe('Improve rules 3: a challenger takes the lead only with a judge outside its family', () => {
  it("keeps the best version when only the challenger's own family preferred it", () => {
    const plan = drive(improve('claude'), answer('fails'), RULES_3)
    expect(roundTwo(plan)).toMatchObject({ result: 'unjudged', judgedBy: ['models'] })
    expect(roundTwo(plan).reason).toBe(
      "Only judges from the challenger's own model family preferred it, so the best version stays."
    )
    expect(plan.loop!.improve!.best).toMatchObject({ round: 1 })
    expect(plan.outcome?.gaps.join('\n')).toContain("challenger's own model family")
  })

  it('lets a judge of another family, or a sure JEV, promote it', () => {
    const crossed = drive(improve('codex'), answer('fails'), RULES_3)
    expect(roundTwo(crossed)).toMatchObject({ result: 'new-best', judgedBy: ['models'] })
    const jev = drive(improve('claude'), answer('prefers-challenger'), RULES_3)
    expect(roundTwo(jev)).toMatchObject({ result: 'new-best', judgedBy: ['jev'] })
  })

  it('judges runs admitted under older rules as they were', () => {
    const older = drive(improve('claude'), answer('fails'))
    expect(roundTwo(older)).toMatchObject({ result: 'new-best', judgedBy: ['models'] })
  })

  it('rejects an unknown-lineage challenger when only an unknown-lineage model judge voted for it', () => {
    const best: ImproveVersion = {
      text: {
        label: 'Response A',
        name: 'Claude',
        markdown: 'v1',
        seatId: 'claude-1',
        agentIndex: 0,
        callId: 'c1'
      },
      round: 1,
      role: 'best'
    }
    const challenger: ImproveVersion = {
      text: {
        label: 'Response B',
        name: 'Custom',
        markdown: 'v2',
        seatId: 'custom-1',
        agentIndex: 0,
        callId: 'c2'
      },
      round: 2,
      role: 'improve'
    }
    const decision = decideImproveRound(
      [best, challenger],
      [
        { label: 'Response A', name: 'Claude', markdown: 'v1', seatId: 'claude-1' },
        { label: 'Response B', name: 'Custom', markdown: 'v2', seatId: 'custom-1' }
      ],
      {
        stepId: 'judge',
        state: 'done',
        round: 2,
        calls: [
          {
            id: 'j1',
            stepId: 'judge',
            round: 2,
            agentIndex: 0,
            seatId: 'judge-unknown',
            status: 'done',
            ranking: ['Response B', 'Response A']
          }
        ],
        standings: [
          { label: 'Response B', candidate: 1, averageRank: 1, votes: 1, place: 1 },
          { label: 'Response A', candidate: 0, averageRank: 2, votes: 1, place: 2 }
        ],
        notes: []
      },
      best,
      () => 'unknown'
    )
    expect(decision).toEqual({
      index: 0,
      unjudged: true,
      reason:
        "Only judges from the challenger's own model family preferred it, so the best version stays."
    })
  })
})
