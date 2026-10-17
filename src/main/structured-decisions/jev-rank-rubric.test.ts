import { describe, expect, it } from 'vitest'
import { DecisionProviderError, type DecisionRequest, type DecisionResult } from '../../shared/structured-decisions'
import { jevPool, screenJevByRubric } from './jev-rank-rubric'

function result(request: DecisionRequest, score: number): DecisionResult {
  const answers = Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      { type: 'score' as const, score, legend: {}, probabilities: {}, confidence: 1 }
    ])
  )
  return { provider: 'typesafe', model: 'jev', answers, usage: { inputTokens: 1, outputTokens: 1 } }
}

describe('jevPool', () => {
  it('never lets more than the shared limit run at once, even under churn', async () => {
    const LIMIT = 6
    let active = 0
    let peak = 0
    const work = async (delayMs: number) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      active--
    }
    // Uneven delays so releases and new acquires interleave unpredictably (the race this pins).
    const delays = Array.from({ length: 40 }, (_, index) => (index % 7) + 1)
    await Promise.all([
      jevPool(delays.slice(0, 20), work),
      jevPool(delays.slice(20), work)
    ])
    expect(peak).toBeLessThanOrEqual(LIMIT)
  })
})

describe('screenJevByRubric retry-after', () => {
  const request = {
    task: 'Choose',
    rubric: '',
    candidates: [{ id: 'a', text: 'Option A' }]
  }

  it('waits the honoured Retry-After before its one retry, and succeeds after', async () => {
    let calls = 0
    const waited: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    // @ts-expect-error test shim: records the requested delay without actually waiting for it
    globalThis.setTimeout = (fn: () => void, ms?: number) => {
      waited.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }
    try {
      const ask = async (decision: DecisionRequest): Promise<DecisionResult> => {
        calls++
        if (calls === 1) {
          throw new DecisionProviderError('rate_limited', true, 3_000)
        }
        return result(decision, 3)
      }
      const screen = await screenJevByRubric(request, ask)
      expect(screen.unscored).toEqual([])
      expect(waited).toEqual([3_000])
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('fails retryable, without waiting, when Retry-After exceeds the run budget', async () => {
    let waited = -1
    const originalSetTimeout = globalThis.setTimeout
    // @ts-expect-error test shim
    globalThis.setTimeout = (fn: () => void, ms?: number) => {
      waited = ms ?? 0
      return originalSetTimeout(fn, 0)
    }
    try {
      const ask = async (): Promise<DecisionResult> => {
        throw new DecisionProviderError('rate_limited', true, 60_000)
      }
      const screen = await screenJevByRubric(request, ask)
      expect(screen.unscored).toEqual(['a'])
      expect(screen.lastErrorRetryable).toBe(true)
      // Never slept for the 60s Retry-After (or anything close to it): it gave up instead.
      expect(waited).toBe(-1)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
