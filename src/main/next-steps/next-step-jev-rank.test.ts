import { describe, expect, it, vi } from 'vitest'
import {
  NEXT_STEP_PROMPT_MAX,
  NEXT_STEP_SUGGESTION_MAX,
  type NextStepSuggestion
} from '../../shared/next-step-suggestions'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import {
  buildNextStepJudgeRequest,
  judgeNextStepSuggestions,
  NEXT_STEP_JEV_MAX_REQUEST_BYTES
} from './next-step-jev-rank'

const step = (id: string, risk: 'safe' | 'risky' = 'safe'): NextStepSuggestion => ({
  id,
  title: `Step ${id}`,
  prompt: `Do step ${id}.`,
  risk,
  kind: 'continue'
})

/** A mocked JEV: `yes[stepIndex][criterion]` is the probability it answers. */
function jevAnswering(yes: Record<string, number>) {
  const evaluate = vi.fn(async (request: DecisionRequest): Promise<DecisionResult> => ({
    provider: 'typesafe',
    model: 'jev-1.13.0',
    usage: { inputTokens: 1, outputTokens: 1 },
    answers: Object.fromEntries(
      Object.keys(request.questions).flatMap((id) =>
        yes[id] === undefined ? [] : [[id, { type: 'noul' as const, noul: yes[id]! }]]
      )
    )
  }))
  return {
    evaluate,
    options: { evaluate, credential: async () => 'k'.repeat(24), environment: {} }
  }
}

const criteria = (index: number, value: number) =>
  Object.fromEntries(
    ['valuable', 'specific', 'grounded', 'not_done'].map((id) => [`step_${index}.${id}`, value])
  )

const input = (suggestions: NextStepSuggestion[], over = {}) => ({
  turnText: 'The person asked for a parser fix. The agent fixed it.',
  suggestions,
  rank: true,
  risk: true,
  ...over
})

describe('JEV ranking of a suggestion set', () => {
  it('reorders by score, records the scores, and asks everything in one call', async () => {
    const jev = jevAnswering({ ...criteria(1, 0.1), ...criteria(2, 0.95), ...criteria(3, 0.81) })
    const judged = await judgeNextStepSuggestions(
      input([step('a'), step('b'), step('c')]),
      jev.options
    )
    expect(judged.suggestions.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(judged.rankedBy).toBe('jev')
    expect(judged.jevScores).toEqual({ a: 0.1, b: 0.95, c: 0.81 })
    expect(jev.evaluate).toHaveBeenCalledTimes(1)
    expect(Object.keys(jev.evaluate.mock.calls[0]![0].questions)).toHaveLength(15)
  })

  it('keeps the model order when the top two are too close to call', async () => {
    const jev = jevAnswering({ ...criteria(1, 0.85), ...criteria(2, 0.9) })
    const judged = await judgeNextStepSuggestions(input([step('a'), step('b')]), jev.options)
    expect(judged.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(judged.rankedBy).toBe('model')
    expect(judged.jevScores).toEqual({ a: 0.85, b: 0.9 })
  })

  it('never reorders on an unsure reading, however wide the gap', async () => {
    const jev = jevAnswering({ ...criteria(1, 0.4), ...criteria(2, 0.6) })
    const judged = await judgeNextStepSuggestions(input([step('a'), step('b')]), jev.options)
    expect(judged.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(judged.rankedBy).toBe('model')
    expect(judged.jevScores).toEqual({ a: 0.4, b: 0.6 })
  })

  it('judges the margin on unrounded scores (0.122 stays under 0.125)', async () => {
    const jev = jevAnswering({ ...criteria(1, 0.874), ...criteria(2, 0.996) })
    const judged = await judgeNextStepSuggestions(input([step('a'), step('b')]), jev.options)
    expect(judged.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(judged.rankedBy).toBe('model')
  })

  it('keeps the model order when a step has no reading or JEV fails', async () => {
    const partial = jevAnswering({ ...criteria(2, 0.95) })
    const missing = await judgeNextStepSuggestions(input([step('a'), step('b')]), partial.options)
    expect(missing.suggestions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(missing.rankedBy).toBe('model')

    const evaluate = vi.fn(async () => {
      throw new Error('network down')
    })
    const failed = await judgeNextStepSuggestions(input([step('a'), step('b')]), {
      evaluate,
      credential: async () => 'k'.repeat(24),
      environment: {}
    })
    expect(failed.suggestions).toEqual([step('a'), step('b')])
    expect(failed.rankedBy).toBe('model')
    const unreadable = await judgeNextStepSuggestions(input([step('a'), step('b')]), {
      evaluate,
      credential: () => Promise.reject(new Error('vault locked')),
      environment: {}
    })
    expect(unreadable.suggestions).toEqual([step('a'), step('b')])
    expect(unreadable.rankedBy).toBe('model')
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('gives up on a key lookup that never settles, within the request time limit', async () => {
    vi.useFakeTimers()
    try {
      const jev = jevAnswering({ ...criteria(2, 0.95) })
      const judging = judgeNextStepSuggestions(input([step('a'), step('b')]), {
        ...jev.options,
        credential: () => new Promise<string>(() => {})
      })
      await vi.advanceTimersByTimeAsync(8_000)
      const judged = await judging
      expect(judged.suggestions).toEqual([step('a'), step('b')])
      expect(judged.rankedBy).toBe('model')
      expect(jev.evaluate).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes nothing and calls nothing with JEV turned off or without a key', async () => {
    const jev = jevAnswering({ ...criteria(2, 0.95) })
    const off = await judgeNextStepSuggestions(input([step('a'), step('b')]), {
      ...jev.options,
      environment: { JEV_DECISIONS_DISABLED: '1' }
    })
    const keyless = await judgeNextStepSuggestions(input([step('a'), step('b')]), {
      ...jev.options,
      credential: async () => undefined
    })
    for (const judged of [off, keyless]) {
      expect(judged.suggestions).toEqual([step('a'), step('b')])
      expect(judged.jevScores).toBeUndefined()
    }
    expect(jev.evaluate).not.toHaveBeenCalled()
  })

  it('asks nothing when both switches are off', async () => {
    const jev = jevAnswering({})
    const judged = await judgeNextStepSuggestions(
      input([step('a')], { rank: false, risk: false }),
      jev.options
    )
    expect(judged).toEqual({ suggestions: [step('a')] })
    expect(jev.evaluate).not.toHaveBeenCalled()
  })

  it('with ranking off, keeps the order and asks only the risk questions', async () => {
    const jev = jevAnswering({ 'step_1.risk': 0.1, 'step_2.risk': 0.1 })
    const judged = await judgeNextStepSuggestions(
      input([step('a'), step('b')], { rank: false }),
      jev.options
    )
    expect(judged.rankedBy).toBeUndefined()
    expect(Object.keys(jev.evaluate.mock.calls[0]![0].questions)).toEqual([
      'step_1.risk',
      'step_2.risk'
    ])
  })
})

describe('JEV risk check', () => {
  it('raises a clear yes to risky, never lowers, and leaves an unsure reading alone', async () => {
    const jev = jevAnswering({
      'step_1.risk': 0.85,
      'step_2.risk': 0.02,
      'step_3.risk': 0.6,
      'step_4.risk': 0.95
    })
    const judged = await judgeNextStepSuggestions(
      input([step('a'), step('b', 'risky'), step('c'), step('d', 'risky')], { rank: false }),
      jev.options
    )
    expect(judged.suggestions.map((s) => [s.id, s.risk, s.riskReason, s.jevRisk])).toEqual([
      ['a', 'risky', 'jev', 0.85],
      ['b', 'risky', undefined, 0.02],
      ['c', 'safe', undefined, 0.6],
      ['d', 'risky', undefined, 0.95]
    ])
  })
})

describe('the JEV request', () => {
  it('stays within 64 questions and the byte budget for the largest set', () => {
    const huge = Array.from({ length: NEXT_STEP_SUGGESTION_MAX }, (_, index) => ({
      ...step(`s${index}`),
      title: 't'.repeat(120),
      prompt: '"quoted"\n'.repeat(NEXT_STEP_PROMPT_MAX / 9),
      why: 'w'.repeat(240)
    }))
    const request = buildNextStepJudgeRequest(input(huge, { turnText: 'x\n'.repeat(40_000) }))
    expect(Object.keys(request.questions)).toHaveLength(NEXT_STEP_SUGGESTION_MAX * 5)
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength).toBeLessThanOrEqual(
      NEXT_STEP_JEV_MAX_REQUEST_BYTES
    )
  })
})
