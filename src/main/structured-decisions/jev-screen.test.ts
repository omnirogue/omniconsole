import { describe, expect, it, vi } from 'vitest'
import {
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import { jevScreen, type JevScreenRequest } from './jev-rank'

const key = async () => 'k'.repeat(24)

const request = (count: number, rubric = ''): JevScreenRequest => ({
  task: 'Name a bakery',
  rubric,
  candidates: Array.from({ length: count }, (_, index) => ({
    id: `o${index}`,
    text: `Option ${index}`
  }))
})

/** Scores every score question by the option's number; `fails` decides which requests fail. */
function scorer(fails: (text: string, attempt: number) => boolean = () => false) {
  const attempts = new Map<string, number>()
  return vi.fn(async (decision: DecisionRequest): Promise<DecisionResult> => {
    const text = (decision.state as { response: string }).response
    const attempt = (attempts.get(text) ?? 0) + 1
    attempts.set(text, attempt)
    if (fails(text, attempt)) {
      throw new DecisionProviderError('overloaded')
    }
    const n = Number(text.split(' ')[1])
    return {
      provider: 'typesafe',
      model: 'jev-1.13.0',
      answers: Object.fromEntries(
        Object.keys(decision.questions).map((id) => [
          id,
          {
            type: 'score' as const,
            score: id === 'c2' ? 4 - n : n,
            legend: {},
            probabilities: {},
            confidence: 1
          }
        ])
      ),
      usage: { inputTokens: 1, outputTokens: 0 }
    }
  })
}

describe('jevScreen', () => {
  it('scores every option on the rubric and on each of its lines', async () => {
    const screen = await jevScreen(request(3, '- Short\n- Friendly'), {
      evaluate: scorer(),
      credential: key,
      environment: {}
    })
    expect(screen).toMatchObject({ scores: { o0: 0, o1: 1, o2: 2 }, unscored: [], calls: 3 })
    expect('criteria' in screen && screen.criteria).toEqual([
      { id: 'c1', label: 'Short', scores: { o0: 0, o1: 1, o2: 2 } },
      { id: 'c2', label: 'Friendly', scores: { o0: 4, o1: 3, o2: 2 } }
    ])
  })

  it('retries a failed request once, and leaves out an option that still fails', async () => {
    // Option 1 fails once then scores; option 2 always fails.
    const evaluate = scorer(
      (text, attempt) => (text === 'Option 1' && attempt === 1) || text === 'Option 2'
    )
    const screen = await jevScreen(request(3), { evaluate, credential: key, environment: {} })
    expect(screen).toMatchObject({
      scores: { o0: 0, o1: 1 },
      unscored: ['o2'],
      lastError: 'overloaded',
      calls: 5
    })
  })

  it('fails, with the reason, only when no option could be scored', async () => {
    const screen = await jevScreen(request(2), {
      evaluate: scorer(() => true),
      credential: key,
      environment: {}
    })
    expect(screen).toEqual({ failed: 'JEV could not score any of the 2 options (overloaded)' })
    expect(
      await jevScreen(request(2), { credential: async () => undefined, environment: {} })
    ).toEqual({
      failed: 'no TypeSafe API key (TYPESAFE_API_KEY)'
    })
  })

  it('voids the whole page, retryable, when even one candidate failed for a transient reason', async () => {
    // Option 0 is rate-limited (transient) on both attempts; option 1 gets an invalid response
    // (not transient) on both attempts. Even though option 1's failure alone would be a normal
    // gap, option 0's transient failure means the whole page must not be cached half-scored.
    let calls = 0
    const evaluate = vi.fn(async (decision: DecisionRequest): Promise<DecisionResult> => {
      calls++
      const text = (decision.state as { response: string }).response
      if (text === 'Option 0') {
        throw new DecisionProviderError('rate_limited', true, 100)
      }
      throw new DecisionProviderError('invalid_response')
    })
    const screen = await jevScreen(request(2), { evaluate, credential: key, environment: {} })
    expect(screen).toEqual({
      failed: 'JEV could not score 1 of 2 options (rate_limited)',
      retryable: true
    })
    // Both options were attempted (retried) before the page was declared a transient failure.
    expect(calls).toBeGreaterThan(2)
  })

  it("keeps JEV's confidence and level probabilities per option and criterion, and its tokens", async () => {
    const levels = { '0': 0, '1': 0.1, '2': 0.2, '3': 0.6, '4': 0.1 }
    const evaluate = vi.fn(async (decision: DecisionRequest): Promise<DecisionResult> => ({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      answers: Object.fromEntries(
        Object.keys(decision.questions).map((id) => [
          id,
          {
            type: 'score' as const,
            score: 2.7,
            legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' },
            probabilities: levels,
            confidence: id === 'quality' ? 0.9 : 0.4
          }
        ])
      ),
      usage: { inputTokens: 100, outputTokens: 5 }
    }))
    const screen = await jevScreen(request(2, '- Short'), {
      evaluate,
      credential: key,
      environment: {}
    })
    expect(screen).toMatchObject({
      certainty: {
        o0: { confidence: 0.9, levels: [0, 0.1, 0.2, 0.6, 0.1] },
        o1: { confidence: 0.9, levels: [0, 0.1, 0.2, 0.6, 0.1] }
      },
      usage: { inputTokens: 200, outputTokens: 10 }
    })
    expect('criteria' in screen && screen.criteria[0]!.certainty?.o1).toEqual({
      confidence: 0.4,
      levels: [0, 0.1, 0.2, 0.6, 0.1]
    })
  })

  it('adds no certainty when the answers carried no probabilities', async () => {
    const screen = await jevScreen(request(1), {
      evaluate: scorer(),
      credential: key,
      environment: {}
    })
    expect('scores' in screen && 'certainty' in screen).toBe(false)
  })
})
