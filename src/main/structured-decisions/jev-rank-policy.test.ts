import { describe, expect, it, vi } from 'vitest'
import { DECISION_CONTRACTS } from '../../shared/decision-contracts/decision-contract-library'
import { contractRefOf } from '../../shared/decision-contracts/decision-contract-types'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { jevRank, type JevRankPolicy, type JevRankRequest } from './jev-rank'

const key = async () => 'k'.repeat(24)

const result = (answers: DecisionResult['answers']): DecisionResult => ({
  provider: 'typesafe',
  model: 'jev-1.13.0',
  answers,
  usage: { inputTokens: 1, outputTokens: 0 }
})

const request = (count: number, method: JevRankRequest['method'] = 'auto'): JevRankRequest => ({
  method,
  task: 'Write a tagline',
  rubric: '',
  candidates: Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    text: `Tagline ${index}`
  }))
})

/** Answer n scores n × spread on every question. */
const scored = (spread: number) =>
  vi.fn(async (decision: DecisionRequest) => {
    const n = Number((decision.state as { response: string }).response.split(' ')[1])
    return result(
      Object.fromEntries(
        Object.keys(decision.questions).map((id) => [
          id,
          {
            type: 'score' as const,
            score: n * spread,
            legend: {},
            probabilities: {},
            confidence: 1
          }
        ])
      )
    )
  })

/** The higher-numbered answer wins with `shown` when shown first and `second` when shown second. */
const headToHead = (shown: number, second = shown) =>
  vi.fn(async (decision: DecisionRequest) => {
    const state = decision.state as { response_1: string; response_2: string }
    const higherFirst =
      Number(state.response_1.split(' ')[1]) > Number(state.response_2.split(' ')[1])
    const firstWins = higherFirst ? shown : 1 - second
    return result({
      better: {
        type: 'choice',
        choice: firstWins >= 0.5 ? 'response_1' : 'response_2',
        probabilities: { response_1: firstWins, response_2: 1 - firstWins },
        confidence: 1
      }
    })
  })

// Every ranking policy version 1 publishes: each must judge exactly as today's constants.
const V1_POLICIES = DECISION_CONTRACTS.filter(
  (contract) =>
    contract.version === 1 &&
    (contract.confidence.method === 'auto' || contract.confidence.method === 'pairwise')
).map((contract) => [contractRefOf(contract), contract.confidence as JevRankPolicy] as const)

const rank = (req: JevRankRequest, evaluate: ReturnType<typeof scored>) =>
  jevRank(req, { evaluate, credential: key, environment: {} })

describe('a v1 ranking policy judges exactly as the constants', () => {
  it('covers every ranking contract', () => {
    expect(V1_POLICIES.map(([ref]) => ref).sort()).toEqual(
      [
        'council-final-check@1',
        'council-peer-rank@1',
        'decide-compare-line@1',
        'decide-final-check@1',
        'find-final@1',
        'generic-criterion-line@1',
        'generic-final-check@1',
        'generic-rank-ballot@1',
        'improve-judge@1'
      ].sort()
    )
  })

  // Both-orders probabilities on and around the band's edges, and an order that flips.
  const pairs: [string, number, number][] = [
    ['clearly sure', 0.95, 0.95],
    ['just inside the low edge', 0.79, 0.79],
    ['on the edge', 0.8, 0.8],
    ['just outside', 0.81, 0.81],
    ['a coin toss', 0.5, 0.5],
    ['flips with the order', 0.7, 0.2]
  ]

  it.each(V1_POLICIES)('%s: head to head', async (_ref, policy) => {
    for (const [, shown, second] of pairs) {
      for (const method of ['auto', 'pairwise'] as const) {
        const today = await rank(request(3, method), headToHead(shown, second))
        const frozen = await rank({ ...request(3, method), policy }, headToHead(shown, second))
        expect(frozen).toEqual(today)
      }
    }
  })

  it.each(V1_POLICIES)(
    '%s: rubric scores, and auto past the pairwise cut-off',
    async (_ref, policy) => {
      // Gaps of 0.49, 0.5 and 0.51 between the top two, around the 0.5 margin.
      for (const spread of [0.49, 0.5, 0.51]) {
        for (const [count, method] of [
          [3, 'rubric'],
          [6, 'auto'],
          [5, 'auto']
        ] as const) {
          const evaluate = count === 5 ? headToHead(0.9) : scored(spread)
          const today = await rank(request(count, method), evaluate)
          const frozen = await rank({ ...request(count, method), policy }, evaluate)
          expect(frozen).toEqual(today)
        }
      }
    }
  )
})

describe('the policy is what decides, not a constant beside it', () => {
  it('a wider band makes a ballot unsure that the constants call sure', async () => {
    const policy: JevRankPolicy = { method: 'pairwise', pairBand: [0.1, 0.9] }
    expect(await rank(request(2, 'pairwise'), headToHead(0.85))).toMatchObject({ unsure: false })
    const wide = await rank({ ...request(2, 'pairwise'), policy }, headToHead(0.85))
    expect(wide).toMatchObject({ unsure: true, unsureReason: expect.stringContaining('0.1–0.9') })
  })

  it('a wider margin and a lower cut-off change the method and the verdict', async () => {
    const policy: JevRankPolicy = {
      method: 'auto',
      pairwiseUpTo: 2,
      scoreMargin: 1,
      pairBand: [0.2, 0.8]
    }
    const today = await rank(request(3), headToHead(0.95))
    expect(today).toMatchObject({ method: 'pairwise', unsure: false })
    const frozen = await rank({ ...request(3), policy }, scored(0.6))
    expect(frozen).toMatchObject({ method: 'rubric', unsure: true })
    expect(frozen).toMatchObject({ unsureReason: expect.stringContaining('less than 1') })
  })
})
