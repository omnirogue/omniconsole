import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../../../src/shared/structured-decisions'
import {
  gateReport,
  probeFinalCheck,
  probeOneAnswer,
  probeSetAside,
  type GateSample
} from './noul-gates'

const yes = (probability: number): DecisionResult => ({
  provider: 'typesafe',
  model: 'jev-1.13.0',
  answers: { yes: { type: 'noul', noul: probability } },
  usage: { inputTokens: 1_000, outputTokens: 0 }
})

describe('gateReport', () => {
  it('reports NOUL accuracy per threshold, Brier, the unsure band and cost against today’s rule', () => {
    const samples: GateSample[] = [
      {
        id: '1',
        truth: true,
        noul: { probability: 0.9, tokens: { input: 1_000, output: 0 } },
        current: { decision: true, probability: 0.75 }
      },
      {
        id: '2',
        truth: false,
        noul: { probability: 0.2, tokens: { input: 1_000, output: 0 } },
        current: { decision: true, probability: 0.5 }
      },
      {
        id: '3',
        truth: true,
        noul: { probability: 0.5, tokens: { input: 1_000, output: 0 } },
        current: { decision: false, probability: 0.1 }
      },
      {
        id: '4',
        truth: false,
        noul: { failed: 'overloaded' },
        current: { failed: 'JEV answered overloaded' }
      }
    ]
    const report = gateReport('set-aside', 'score ≥ 1', samples)
    expect(report.noul).toMatchObject({ answered: 3, failed: 1, unsureRate: 1 / 3 })
    expect(report.noul.brier).toBeCloseTo((0.01 + 0.04 + 0.25) / 3)
    expect(report.noul.byThreshold.find((row) => row.threshold === 0.5)!.accuracy).toBe(1)
    expect(report.noul.byThreshold.find((row) => row.threshold === 0.6)!.accuracy).toBeCloseTo(
      2 / 3
    )
    // 1,000 input tokens at $0.042 per million.
    expect(report.noul.costUsdPerDecision).toBeCloseTo(0.000042)
    // Today's set-aside rule never defers, so it has no unsure rate (not NOUL's band on its probability).
    expect(report.current).toMatchObject({
      failed: 1,
      accuracy: 1 / 3,
      unsureRate: null,
      costUsdPerDecision: 'unknown'
    })
    const ranked = gateReport('final check', 'jevRank', [
      { ...samples[0]!, current: { decision: true, probability: 0.9, unsure: true } },
      { ...samples[1]!, current: { decision: false, probability: 0.5, unsure: false } }
    ])
    // The ranker's own unsure call counts, whatever its probability.
    expect(ranked.current.unsureRate).toBe(0.5)
    expect(report.current.brier).toBeCloseTo((0.0625 + 0.25 + 0.81) / 3)
  })
})

describe('the gate probes', () => {
  it('asks one NOUL question per finding and keeps today’s set-aside rule beside it', async () => {
    const ask = vi.fn(async (request: DecisionRequest) => {
      expect(Object.values(request.questions)[0]!.type).toBe('noul')
      return yes(0.8)
    })
    const samples = await probeSetAside(
      'Find defects',
      [
        { id: 'a', truth: true, text: 'Race', jevScore: 0.5, repeats: 1 },
        { id: 'b', truth: false, text: 'Style', jevScore: 0.5, repeats: 2, keepProbability: 0.3 }
      ],
      ask
    )
    expect(samples.map((sample) => sample.current)).toEqual([
      { decision: false, probability: 0.125 },
      { decision: true, probability: 0.3 }
    ])
    expect(samples[0]!.noul).toEqual({ probability: 0.8, tokens: { input: 1_000, output: 0 } })
  })

  it('treats every question as judgment today, and asks the final check in both orders', async () => {
    const one = await probeOneAnswer(
      [{ id: 'q', question: 'What is 2+2?', kind: 'one-answer' }],
      async () => yes(0.9)
    )
    expect(one[0]).toMatchObject({ truth: true, current: { decision: false } })
    const ask = vi.fn(async (request: DecisionRequest) =>
      yes((request.state as { response_b: string }).response_b === 'good' ? 0.8 : 0.3)
    )
    const rank = vi.fn(async () => ({
      method: 'pairwise' as const,
      model: 'jev-1.13.0',
      order: ['b', 'a'],
      scores: { a: 0.3, b: 0.7 },
      criteria: [],
      unsure: false,
      calls: 2
    }))
    const [sample] = await probeFinalCheck(
      [{ id: 'p', task: 't', a: 'weak', b: 'good', better: 'b' }],
      ask,
      rank
    )
    expect(ask).toHaveBeenCalledTimes(2)
    // (0.8 + (1 − 0.3)) / 2
    expect(sample!.noul).toMatchObject({ probability: 0.75 })
    expect(sample!.current).toEqual({ decision: true, probability: 0.7, unsure: false })
    const failed = await probeFinalCheck(
      [{ id: 'p', task: 't', a: 'x', b: 'y', better: 'a' }],
      ask,
      async () => ({ failed: 'no key' })
    )
    expect(failed[0]!.current).toEqual({ failed: 'no key' })
  })
})
