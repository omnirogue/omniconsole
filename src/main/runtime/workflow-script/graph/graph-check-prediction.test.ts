import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { judgeGraphPrediction, parseGraphPrediction } from './graph-check-prediction'
import {
  assertImproveReplaySupported,
  graphImprovePredicts,
  IMPROVE_RULES
} from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

describe('parseGraphPrediction', () => {
  it('reads every form from the last non-empty line', () => {
    expect(parseGraphPrediction('work\nPREDICTION: PASS')).toEqual({ outcome: 'pass' })
    expect(parseGraphPrediction('work\n  prediction: fail  \n\n')).toEqual({ outcome: 'fail' })
    expect(parseGraphPrediction('PREDICTION: SCORE >= 80')).toEqual({ op: '>=', score: 80 })
    expect(parseGraphPrediction('PREDICTION: SCORE <= -1.5')).toEqual({ op: '<=', score: -1.5 })
    expect(parseGraphPrediction('PREDICTION: SCORE > 3')).toEqual({ op: '>', score: 3 })
    expect(parseGraphPrediction('PREDICTION: SCORE<3')).toEqual({ op: '<', score: 3 })
    expect(parseGraphPrediction('PREDICTION: SCORE ≥ 80')).toEqual({ op: '>=', score: 80 })
    expect(parseGraphPrediction('PREDICTION: SCORE ≤ 2e1')).toEqual({ op: '<=', score: 20 })
  })

  it('finds none unless it is the very last line, and exactly the form', () => {
    expect(parseGraphPrediction('PREDICTION: PASS\nmore text')).toBeUndefined()
    expect(parseGraphPrediction('work')).toBeUndefined()
    expect(parseGraphPrediction('')).toBeUndefined()
    expect(parseGraphPrediction('PREDICTION: PASS probably')).toBeUndefined()
    expect(parseGraphPrediction('PREDICTION: SCORE = 80')).toBeUndefined()
    expect(parseGraphPrediction('PREDICTION: SCORE >= high')).toBeUndefined()
  })
})

describe('judgeGraphPrediction', () => {
  const pass = { passed: true, detail: '' }
  const fail = { passed: false, detail: '' }
  it('keeps a held prediction and kills a missed one', () => {
    expect(judgeGraphPrediction('x\nPREDICTION: PASS', pass).verdict).toBe('held')
    expect(judgeGraphPrediction('x\nPREDICTION: PASS', fail).verdict).toBe('missed')
    expect(judgeGraphPrediction('x\nPREDICTION: FAIL', fail).verdict).toBe('held')
    expect(judgeGraphPrediction('x\nPREDICTION: FAIL', pass).verdict).toBe('missed')
    expect(judgeGraphPrediction('x\nPREDICTION: SCORE >= 80', { ...pass, score: 84 })).toEqual({
      verdict: 'held',
      predicted: { op: '>=', score: 80 },
      measured: { passed: true, score: 84 }
    })
    expect(judgeGraphPrediction('x\nPREDICTION: SCORE > 80', { ...fail, score: 80 }).verdict).toBe(
      'missed'
    )
    expect(judgeGraphPrediction('x\nPREDICTION: SCORE < 80', { ...fail, score: 79 }).verdict).toBe(
      'held'
    )
    expect(judgeGraphPrediction('x\nPREDICTION: SCORE <= 80', pass).verdict).toBe('missed')
  })

  it('kills a version with no prediction, and tests none when the check could not run', () => {
    expect(judgeGraphPrediction('x', pass)).toEqual({ verdict: 'missing' })
    expect(
      judgeGraphPrediction('x\nPREDICTION: PASS', { ...fail, unavailable: true }).verdict
    ).toBe('untested')
  })
})

function improve(check: WorkflowCheck): WorkflowSpec {
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
        agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
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
      maxRounds: 2,
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
const PREDICT: WorkflowCheck = { command: 'node t.mjs', predict: true }

// Per version: its prediction line (or none), then what its check measures.
type Plan = { line?: string; passed: boolean; score?: number }
const ROUNDS: Plan[][] = [
  [{ line: 'PASS', passed: true }, { line: 'FAIL', passed: true }, { passed: true }],
  [
    { line: 'SCORE >= 80', passed: true, score: 84 },
    { line: 'SCORE < 90', passed: true, score: 95 },
    { line: 'FAIL', passed: false }
  ]
]

function answer(rounds: Plan[][], judged: string[][] = []) {
  const planOf = (markdown: string) => {
    const [round, agent] = (/^v(\d+)-(\d+)/.exec(markdown) ?? []).slice(1).map(Number)
    return rounds[round! - 1]![agent!]!
  }
  return (call: GraphCall): unknown => {
    if (call.check) {
      const { passed, score } = planOf(call.check.candidate)
      return { markdown: 'check', passed, detail: '', ...(score !== undefined ? { score } : {}) }
    }
    if (call.jev) {
      judged.push(call.jev.candidates.map((entry) => entry.markdown))
      return {
        markdown: `FINAL RANKING:\n${call.jev.candidates.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`
      }
    }
    if (call.stepId !== 'improve') {
      return undefined
    }
    const { line } = rounds[call.round - 1]![call.agentIndex]!
    return text(`v${call.round}-${call.agentIndex}${line ? `\nPREDICTION: ${line}` : ''}`)
  }
}

describe('Improve rules 2: each version predicts its result', () => {
  it('kills missed and missing predictions before the check compares anything', () => {
    const judged: string[][] = []
    const plan = drive(improve(PREDICT), answer(ROUNDS, judged), RULES_2)
    const trail = plan.loop!.improve!
    expect(judged).toEqual([])
    expect(trail.rounds[0]!.result).toBe('first')
    expect(trail.rounds[0]!.candidates.map((entry) => entry.prediction?.verdict)).toEqual([
      'held',
      'missed',
      'missing'
    ])
    expect(trail.rounds[0]!.candidates[0]!.accepted).toBe(true)
    // v2-1 scores 95, above the kept v2-0's 84, but its prediction missed, so it never contends.
    expect(trail.best?.round).toBe(2)
    expect(plan.outcome?.final?.markdown).toContain('v2-0')
    const round2 = trail.rounds[1]!
    expect(round2.judgedBy).toEqual(['check'])
    expect(round2.candidates.find((entry) => entry.accepted)?.prediction).toEqual({
      verdict: 'held',
      predicted: { op: '>=', score: 80 },
      measured: { passed: true, score: 84 }
    })
    expect(round2.candidates.at(-1)?.prediction?.verdict).toBe('missed')
    const prompts = plan.calls.filter((call) => call.stepId === 'improve' && !call.check)
    expect(prompts.every((call) => call.prompt.includes('PREDICTION: SCORE >= <number>'))).toBe(
      true
    )
  })

  it('records a round whose every new version was killed, and goes on', () => {
    const rounds: Plan[][] = [
      [{ passed: true }, { line: 'FAIL', passed: true }, { passed: false }],
      ROUNDS[0]!
    ]
    const trail = drive(improve(PREDICT), answer(rounds), RULES_2).loop!.improve!
    expect(trail.rounds[0]).toMatchObject({
      result: 'failed',
      reason: "Every new version's prediction missed its test result, so none was kept."
    })
    expect(trail.rounds[0]!.candidates).toHaveLength(3)
    expect(trail.rounds[1]!.result).toBe('first')
  })

  it('does nothing below rules 2, and refuses such a saved run', () => {
    const plan = drive(improve(PREDICT), answer(ROUNDS), RULES_1)
    const trail = plan.loop!.improve!
    expect(trail.rounds.flatMap((round) => round.candidates).some((c) => c.prediction)).toBe(false)
    expect(plan.calls.some((call) => call.prompt.includes('PREDICTION: SCORE >= <number>'))).toBe(
      false
    )
    expect(plan.outcome?.final?.markdown).toContain('v2-1')
    expect(graphImprovePredicts({ spec: improve(PREDICT), improveRules: 1 })).toBe(false)
    expect(() => assertImproveReplaySupported(improve(PREDICT), {})).toThrow()
    expect(() =>
      assertImproveReplaySupported(improve(PREDICT), { host: { improveRules: 2 } })
    ).not.toThrow()
  })
})
