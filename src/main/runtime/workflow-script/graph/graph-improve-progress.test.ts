import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  assertImproveReplaySupported,
  graphImproveRules,
  IMPROVE_RULES
} from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

function improve(check: WorkflowCheck, maxRounds = 6): WorkflowSpec {
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
        agents: [{ route: 'codex' }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds,
      patience: 2,
      explore: 'low',
      check
    }
  }
}

const RULES_2: Partial<GraphConfig> = {
  access: 'workspace-read',
  improveUnresolvedRounds: true,
  improveRules: IMPROVE_RULES
}
const RULES_1: Partial<GraphConfig> = { access: 'workspace-read', improveUnresolvedRounds: true }

/**
 * Round r's version passes `passed[r - 1]` of two practice cases; the judges prefer the newest
 * version unless `keep` names the round in which they keep the best one.
 */
function answer(passed: number[], keep: number[] = [], total = 2) {
  return (call: GraphCall): unknown => {
    if (call.check) {
      const round = Number(/^v(\d+)/.exec(call.check.candidate)?.[1])
      const count = passed[round - 1] ?? 0
      return {
        markdown: 'check',
        passed: count === total,
        detail: `v${round} passed ${count}`,
        ...(total ? { cases: { total, passed: count, unavailable: 0 } } : {})
      }
    }
    if (call.jev) {
      const newest = call.jev.candidates.findIndex((entry) => entry.markdown === `v${call.round}`)
      const order = keep.includes(call.round)
        ? [...call.jev.candidates.keys()].filter((index) => index !== newest).concat(newest)
        : [newest, ...[...call.jev.candidates.keys()].filter((index) => index !== newest)]
      return {
        markdown: `FINAL RANKING:\n${order.map((index, place) => `${place + 1}. ${call.jev!.candidates[index]!.label}`).join('\n')}`
      }
    }
    return call.stepId === 'improve' ? text(`v${call.round}`) : undefined
  }
}

const trailOf = (plan: ReturnType<typeof drive>) => plan.loop!.improve!
const CASES: WorkflowCheck = { command: 'node t.mjs {case}', cases: ['a', 'b'] }

describe('Improve rules 2: measured stopping', () => {
  it('lets a judges-only win replace the best version without resetting patience', () => {
    const plan = drive(improve(CASES), answer([1, 1, 1, 1, 1, 1]), RULES_2)
    const trail = trailOf(plan)
    expect(trail.rounds.map((round) => round.result)).toEqual(['first', 'new-best', 'new-best'])
    expect(trail.rounds.map((round) => round.noGain)).toEqual([undefined, true, true])
    expect(trail).toMatchObject({ stop: 'plateau', stale: 2, measured: true, best: { round: 3 } })
    expect(plan.outcome?.final?.markdown).toContain(
      'Stopped: 2 rounds in a row brought no better test result.'
    )
    expect(plan.outcome?.final?.markdown).toContain(
      'beat the best version (decided by the check and JEV), with no better test result.'
    )
  })

  it('keeps the old rule under rules 1: a judges-only win resets patience', () => {
    const plan = drive(improve({ command: 'npm test' }), answer([1, 1, 1, 1, 1, 1], [], 0), RULES_1)
    const trail = trailOf(plan)
    expect(trail.stop).toBe('max-rounds')
    expect(trail.rounds.every((round) => round.noGain === undefined)).toBe(true)
    expect(trail.measured).toBeUndefined()
  })

  it('counts more practice cases passed as progress, and stops once a passing best is kept', () => {
    const plan = drive(improve(CASES), answer([0, 1, 1, 2, 2, 2], [5]), RULES_2)
    const trail = trailOf(plan)
    expect(trail.rounds.map((round) => [round.result, round.noGain ?? false])).toEqual([
      ['first', false],
      ['new-best', false],
      ['new-best', true],
      ['new-best', false],
      ['kept', false]
    ])
    expect(trail.rounds[3]!.judgedBy).toEqual(['check'])
    expect(trail.rounds[4]!.candidates.map((entry) => entry.check?.cases)).toEqual([
      { passed: 2, total: 2 },
      { passed: 2, total: 2 }
    ])
    expect(trail.stop).toBe('passing-kept')
    expect(plan.loop?.status).toBe('verified')
    expect(plan.outcome?.final?.markdown).toContain(
      'Stopped: every practice case passes, and the judges preferred the best version to each new change.'
    )
  })

  it('does not stop passing-kept when only the check kept the best, or without practice cases', () => {
    const byCheck = drive(improve(CASES, 4), answer([2, 1, 1, 1]), RULES_2)
    expect(trailOf(byCheck).stop).toBe('plateau')
    const noCases = drive(improve({ command: 'npm test' }, 4), answer([2, 2, 2, 2], [2, 3, 4], 0), {
      ...RULES_2
    })
    expect(trailOf(noCases).rounds.map((round) => round.result)).toEqual(['first', 'kept', 'kept'])
    expect(trailOf(noCases).stop).toBe('plateau')
  })

  it('asks for SCORE on the last line, the cases and the time limit only under rules 2', () => {
    const timed = { ...CASES, timeoutSeconds: 30 }
    const plan = drive(improve(timed, 2), answer([1, 1]), RULES_2)
    const check = plan.calls.find((call) => call.check)!.check!
    expect(check).toEqual({
      command: 'node t.mjs {case}',
      candidate: 'v1',
      scoreLastLine: true,
      cases: ['a', 'b'],
      timeoutSeconds: 30
    })
    const plain = drive(improve({ command: 'npm test' }, 2), answer([1, 1], [], 0), RULES_2)
    expect(plain.calls.find((call) => call.check)!.check).toEqual({
      command: 'npm test',
      candidate: 'v1',
      scoreLastLine: true
    })
    const old = drive(improve({ command: 'npm test' }, 2), answer([1, 1], [], 0), RULES_1)
    expect(Object.keys(old.calls.find((call) => call.check)!.check!)).toEqual([
      'command',
      'candidate'
    ])
  })

  it('shows the improvers every practice case and how many the best version passes', () => {
    const plan = drive(improve(CASES, 2), answer([1, 1]), RULES_2)
    const second = plan.calls.find((call) => call.id === 'improve/r2/a0')!.prompt
    expect(second).toContain('on each of 2 practice cases, one run per case')
    expect(second).toContain('The practice cases:\n1. a\n2. b')
    expect(second).toContain('The best version FAILS it (1 of 2 cases pass)')
    expect(second).toContain('When the last line printed is "SCORE: <number>", it ranks')
  })
})

describe('the Improve replay gate', () => {
  it('reads the frozen rules defensively', () => {
    expect(graphImproveRules({ host: { improveRules: 2, improveUnresolvedRounds: true } })).toEqual(
      { improveRules: 2, improveUnresolvedRounds: true }
    )
    expect(graphImproveRules({ host: { improveRules: '2' } })).toEqual({})
  })

  it('refuses practice cases or a time limit in a run admitted under older rules', () => {
    for (const check of [CASES, { command: 'npm test', timeoutSeconds: 30 }]) {
      expect(() => assertImproveReplaySupported(improve(check), { host: {} })).toThrow(
        "can't replay them"
      )
      expect(() =>
        assertImproveReplaySupported(improve(check), { host: { improveRules: 1 } })
      ).toThrow("can't replay them")
      expect(() =>
        assertImproveReplaySupported(improve(check), { host: { improveRules: 2 } })
      ).not.toThrow()
    }
    expect(() =>
      assertImproveReplaySupported(improve({ command: 'npm test' }), { host: {} })
    ).not.toThrow()
  })
})
