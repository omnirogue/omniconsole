import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { graphJevBallot } from '../runtime/workflow-script/graph/graph-jev'
import { jevRank, type JevRankRequest } from './jev-rank'
import { JEV_PAIR_RESPONSE_BYTES, JEV_RESPONSE_BYTES } from './jev-rank-rubric'

const key = async () => 'k'.repeat(24)

function result(answers: DecisionResult['answers']): DecisionResult {
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 1, outputTokens: 0 }
  }
}

const request = (count: number, method: JevRankRequest['method'] = 'auto'): JevRankRequest => ({
  method,
  task: 'Write a tagline',
  rubric: '',
  candidates: Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    text: `Tagline ${index}`
  }))
})

/** Scores every Score question by the answer's number, times `spread`. */
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

/** Prefers the higher-numbered answer with probability `p`, from either position. */
const headToHead = (p: number) =>
  vi.fn(async (decision: DecisionRequest) => {
    const state = decision.state as { response_1: string; response_2: string }
    const first = Number(state.response_1.split(' ')[1])
    const second = Number(state.response_2.split(' ')[1])
    const firstWins = first > second ? p : 1 - p
    return result({
      better: {
        type: 'choice',
        choice: firstWins >= 0.5 ? 'response_1' : 'response_2',
        probabilities: { response_1: firstWins, response_2: 1 - firstWins },
        confidence: 1
      },
      driver: {
        type: 'choice',
        choice: 'completeness',
        probabilities: { completeness: 1 },
        confidence: 1
      }
    })
  })

describe('jevRank', () => {
  it('compares a few answers head to head in both orders, and many by rubric scores', async () => {
    const pairwise = headToHead(0.95)
    const few = await jevRank(request(3), { evaluate: pairwise, credential: key, environment: {} })
    expect(pairwise).toHaveBeenCalledTimes(6)
    expect(few).toMatchObject({ method: 'pairwise', order: ['c2', 'c1', 'c0'], unsure: false })
    expect(pairwise.mock.calls[0]![0].questions).toHaveProperty('driver')
    expect(few).toMatchObject({
      drivers: [expect.objectContaining({ id: 'completeness', comparisons: 6 })]
    })
    const rubric = scored(0.5)
    const many = await jevRank(request(7), { evaluate: rubric, credential: key, environment: {} })
    expect(rubric).toHaveBeenCalledTimes(7)
    expect(many).toMatchObject({
      method: 'rubric',
      order: ['c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0']
    })
  })

  it('keeps the verdict when JEV names no deciding criterion, or one that is not in the rubric', async () => {
    const full = headToHead(0.95)
    let call = 0
    const partial = vi.fn(async (decision: DecisionRequest) => {
      const answer = await full(decision)
      const { driver: _driver, ...better } = answer.answers
      call++
      return call % 2
        ? result(better)
        : result({
            ...better,
            driver: { type: 'choice', choice: 'nonsense', probabilities: {}, confidence: 1 }
          })
    })
    const ranked = await jevRank(request(3), {
      evaluate: partial,
      credential: key,
      environment: {}
    })
    expect(ranked).toMatchObject({ method: 'pairwise', order: ['c2', 'c1', 'c0'], drivers: [] })
  })

  it('is unsure when the top two are close, and sure when they are not', async () => {
    const close = await jevRank(request(2), {
      evaluate: headToHead(0.6),
      credential: key,
      environment: {}
    })
    expect(close).toMatchObject({ unsure: true })
    expect('unsureReason' in close && close.unsureReason).toContain('0.60')
    const clear = await jevRank(request(2), {
      evaluate: headToHead(0.9),
      credential: key,
      environment: {}
    })
    expect(clear).toMatchObject({ unsure: false })
    const nearScores = await jevRank(request(6, 'rubric'), {
      evaluate: scored(0.3),
      credential: key,
      environment: {}
    })
    expect(nearScores).toMatchObject({ unsure: true })
  })

  it('is unsure when the preferred answer changes with the order it is shown in', async () => {
    // Always prefers whichever answer is shown first.
    const positional = vi.fn(async () =>
      result({
        better: {
          type: 'choice',
          choice: 'response_1',
          probabilities: { response_1: 0.9, response_2: 0.1 },
          confidence: 1
        },
        driver: {
          type: 'choice',
          choice: 'clarity',
          probabilities: { clarity: 1 },
          confidence: 1
        }
      })
    )
    const out = await jevRank(request(2), {
      evaluate: positional,
      credential: key,
      environment: {}
    })
    expect(out).toMatchObject({ unsure: true })
    expect('unsureReason' in out && out.unsureReason).toContain('shown first')
  })

  it('is unsure when its top answer does not clearly beat the best version so far', async () => {
    // Not transitive: c2 clearly beats c1 (the runner-up) but barely beats c0, the incumbent.
    const beats: Record<string, number> = { '2>1': 0.95, '2>0': 0.6, '1>0': 0.9 }
    const table = vi.fn(async (decision: DecisionRequest) => {
      const state = decision.state as { response_1: string; response_2: string }
      const first = state.response_1.split(' ')[1]!
      const second = state.response_2.split(' ')[1]!
      const firstWins = beats[`${first}>${second}`] ?? 1 - beats[`${second}>${first}`]!
      return result({
        better: {
          type: 'choice',
          choice: firstWins >= 0.5 ? 'response_1' : 'response_2',
          probabilities: { response_1: firstWins, response_2: 1 - firstWins },
          confidence: 1
        },
        driver: {
          type: 'choice',
          choice: 'task_fit',
          probabilities: { task_fit: 1 },
          confidence: 1
        }
      })
    })
    const options = { evaluate: table, credential: key, environment: {} }
    const plain = await jevRank(request(3), options)
    expect(plain).toMatchObject({ order: ['c2', 'c1', 'c0'], unsure: false })
    const defended = await jevRank({ ...request(3), incumbent: 'c0' }, options)
    expect(defended).toMatchObject({ order: ['c2', 'c1', 'c0'], unsure: true })
    expect('unsureReason' in defended && defended.unsureReason).toContain('best version so far')
    // An incumbent JEV puts first needs no second look.
    const kept = await jevRank({ ...request(3), incumbent: 'c2' }, options)
    expect(kept).toMatchObject({ unsure: false })
  })

  it('scores each bulleted rubric line as its own criterion', async () => {
    const evaluate = scored(1)
    const out = await jevRank(
      { ...request(2, 'rubric'), rubric: 'Judge taglines:\n- Memorable\n- Backed by proof' },
      { evaluate, credential: key, environment: {} }
    )
    expect(Object.keys(evaluate.mock.calls[0]![0].questions)).toEqual(['quality', 'c1', 'c2'])
    expect('criteria' in out && out.criteria.map((criterion) => criterion.label)).toEqual([
      'Memorable',
      'Backed by proof'
    ])
  })

  it('gives no ranking without a key, when turned off, or when any call fails', async () => {
    expect(
      await jevRank(request(2), { credential: async () => undefined, environment: {} })
    ).toEqual({ failed: expect.stringContaining('TYPESAFE_API_KEY') })
    expect(
      await jevRank(request(2), { credential: key, environment: { JEV_DECISIONS_DISABLED: '1' } })
    ).toEqual({ failed: expect.stringContaining('turned off') })
    const flaky = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(
      await jevRank(request(2), { evaluate: flaky, credential: key, environment: {} })
    ).toEqual({ failed: 'boom' })
  })

  it('skips JEV calls for identical pairwise pairs and deduplicates identical rubric candidates', async () => {
    const pairwise = headToHead(0.95)
    const tied = await jevRank(
      {
        method: 'pairwise',
        task: 'Write a tagline',
        rubric: '',
        candidates: [
          { id: 'c0', text: 'Same tagline' },
          { id: 'c1', text: '  Same tagline\n' }
        ]
      },
      { evaluate: pairwise, credential: key, environment: {} }
    )
    expect(pairwise).toHaveBeenCalledTimes(0)
    expect(tied).toMatchObject({ method: 'pairwise', order: ['c0', 'c1'], calls: 0, unsure: true })

    const rubric = scored(1)
    const deduped = await jevRank(
      {
        method: 'rubric',
        task: 'Write a tagline',
        rubric: '',
        candidates: [
          { id: 'c0', text: 'Tagline 1' },
          { id: 'c1', text: 'Tagline 1\n' },
          { id: 'c2', text: 'Tagline 3' }
        ]
      },
      { evaluate: rubric, credential: key, environment: {} }
    )
    expect(rubric).toHaveBeenCalledTimes(2)
    expect(deduped).toMatchObject({ method: 'rubric', order: ['c2', 'c0', 'c1'], calls: 2 })
  })

  it('tells long answers apart by their whole text, never only by what JEV is shown', async () => {
    // Past JEV_PAIR_RESPONSE_BYTES and JEV_RESPONSE_BYTES, so every answer below is cut when sent.
    const long = (n: number, tail = '') => `Tagline ${n} ${'x'.repeat(50_000)}${tail}`
    const pair = (texts: string[]): JevRankRequest => ({
      method: 'pairwise',
      task: 'Write a tagline',
      rubric: '',
      candidates: texts.map((text, index) => ({ id: `c${index}`, text }))
    })
    const options = (evaluate: ReturnType<typeof headToHead>) => ({
      evaluate,
      credential: key,
      environment: {}
    })

    // The same answer padded or wrapped differently, across its whole length, is never asked about.
    const padded = headToHead(0.95)
    const same = await jevRank(
      pair([long(1, ' end'), `\n\n\n${long(1, '\n  end')}`]),
      options(padded)
    )
    expect(padded).toHaveBeenCalledTimes(0)
    expect(same).toMatchObject({ calls: 0, unsure: true })

    // A difference JEV reads is asked, in both orders.
    const asked = headToHead(0.95)
    const differ = await jevRank(pair([long(1), long(2)]), options(asked))
    expect(asked).toHaveBeenCalledTimes(2)
    expect(differ).toMatchObject({ order: ['c1', 'c0'], calls: 2, unsure: false })

    // A difference only past the cut is still a difference: JEV is asked, and still sent the cut.
    const unread = headToHead(0.95)
    const past = await jevRank(pair([long(1, ' A'), long(1, ' B')]), options(unread))
    expect(unread).toHaveBeenCalledTimes(2)
    expect(past).toMatchObject({ calls: 2 })
    const sent = unread.mock.calls[0]![0].state as { response_1: string; response_2: string }
    expect(sent.response_1).toContain('…[cut to fit]')
    expect(new TextEncoder().encode(sent.response_2).byteLength).toBeLessThan(
      JEV_PAIR_RESPONSE_BYTES + 32
    )

    const rubric = scored(1)
    const scoredTwice = await jevRank(
      {
        ...pair([long(1, ' A'), `\r\n${long(1, '  A')}`, long(1, ' B')]),
        method: 'rubric'
      },
      { evaluate: rubric, credential: key, environment: {} }
    )
    expect(rubric).toHaveBeenCalledTimes(2)
    expect(scoredTwice).toMatchObject({ calls: 2 })
    const response = (rubric.mock.calls[1]![0].state as { response: string }).response
    expect(new TextEncoder().encode(response).byteLength).toBeLessThan(JEV_RESPONSE_BYTES + 32)
  })

  it('asks a pair JEV ties shown one way only that way: no order breaks a tie', async () => {
    const lean = (first: number) =>
      vi.fn(async () =>
        result({
          better: {
            type: 'choice',
            choice: first >= 0.5 ? 'response_1' : 'response_2',
            probabilities: { response_1: first, response_2: 1 - first },
            confidence: 1
          }
        })
      )
    const coin = lean(0.51)
    const tied = await jevRank(request(2, 'pairwise'), {
      evaluate: coin,
      credential: key,
      environment: {}
    })
    expect(coin).toHaveBeenCalledTimes(1)
    // The tie stands for both orders: unsure, and only the order JEV was shown is recorded.
    expect(tied).toMatchObject({
      calls: 1,
      unsure: true,
      pairs: [{ first: 'c0', second: 'c1', probability: 0.51 }]
    })
    expect('unsureReason' in tied && tied.unsureReason).toContain('0.51')
    // A lean JEV can tell apart is still asked the other way round.
    const apart = lean(0.56)
    await jevRank(request(2, 'pairwise'), { evaluate: apart, credential: key, environment: {} })
    expect(apart).toHaveBeenCalledTimes(2)
  })

  it('never asks a pair whose two answers can no longer reach the top two', async () => {
    const pairwise = headToHead(0.95)
    const ranked = await jevRank(request(4, 'pairwise'), {
      evaluate: pairwise,
      credential: key,
      environment: {}
    })
    // After two rounds c0 and c1 have lost every game: even winning the rest, neither reaches c2.
    expect(pairwise).toHaveBeenCalledTimes(10)
    expect(ranked).toMatchObject({ order: ['c3', 'c2', 'c0', 'c1'], calls: 10, unsure: false })
    const pairs = 'pairs' in ranked ? (ranked.pairs ?? []) : []
    expect(pairs).toHaveLength(10)
    expect(pairs.some((entry) => [entry.first, entry.second].sort().join() === 'c0,c1')).toBe(false)
    // With three answers two always stay in the top two, so every pair is asked.
    const three = headToHead(0.95)
    await jevRank(request(3, 'pairwise'), { evaluate: three, credential: key, environment: {} })
    expect(three).toHaveBeenCalledTimes(6)
  })

  it('screens 35% of rubric criteria first and prunes trailing candidates when 6+ criteria are given', async () => {
    const sixCriteriaRubric = [
      '- Accuracy: Is it accurate?',
      '- Completeness: Is it complete?',
      '- Clarity: Is it clear?',
      '- Conciseness: Is it concise?',
      '- Actionability: Is it actionable?',
      '- Robustness: Is it robust?'
    ].join('\n')
    const rubric = scored(0.5)
    const ranked = await jevRank(
      {
        ...request(7, 'rubric'),
        rubric: sixCriteriaRubric
      },
      { evaluate: rubric, credential: key, environment: {} }
    )
    // 7 Phase-1 screening calls (quality + first 3 criteria: ceil(6 * 0.35) = 3) + 2 Phase-2 calls for survivors c5 and c6 (remaining 3 criteria).
    expect(rubric).toHaveBeenCalledTimes(9)
    expect(Object.keys(rubric.mock.calls[0]![0].questions)).toEqual(['quality', 'c1', 'c2', 'c3'])
    expect(Object.keys(rubric.mock.calls[7]![0].questions)).toEqual(['c4', 'c5', 'c6'])
    expect(ranked).toMatchObject({
      method: 'rubric',
      order: ['c6', 'c5', 'c4', 'c3', 'c2', 'c1', 'c0'],
      calls: 9
    })

    const ballot = await graphJevBallot(
      {
        method: 'rubric',
        task: 'Write a tagline',
        instruction: sixCriteriaRubric,
        candidates: Array.from({ length: 7 }, (_, index) => ({
          label: `c${index}`,
          markdown: `Tagline ${index}`
        }))
      },
      { evaluate: scored(0.5), credential: key, environment: {} }
    )
    expect('markdown' in ballot).toBe(true)
    if ('markdown' in ballot) {
      expect(ballot.markdown).not.toContain('NaN')
      expect(ballot.markdown).toContain(
        '- c6: 3.00 of 4 · Accuracy: Is it accurate 3.0 · Completeness: Is it complete 3.0 · Clarity: Is it clear 3.0 · Conciseness: Is it concise 3.0 · Actionability: Is it actionable 3.0 · Robustness: Is it robust 3.0'
      )
      expect(ballot.markdown).toContain(
        '- c0: 0.00 of 4 · Accuracy: Is it accurate 0.0 · Completeness: Is it complete 0.0 · Clarity: Is it clear 0.0'
      )
      expect(ballot.markdown).not.toContain(
        '- c0: 0.00 of 4 · Accuracy: Is it accurate 0.0 · Completeness: Is it complete 0.0 · Clarity: Is it clear 0.0 · Conciseness'
      )
      expect(ballot.markdown).toContain('- Robustness: Is it robust: c6 (3.00)')
    }
  })
})
