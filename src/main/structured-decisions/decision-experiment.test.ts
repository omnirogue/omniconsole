import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import {
  DECISION_EXPERIMENT_MAX_REQUESTS,
  DECISION_EXPERIMENT_SUITE,
  DECISION_EXPERIMENT_TARIFF,
  runDecisionExperiment,
  type DecisionExperimentBaseline
} from './decision-experiment'
import { decisionExperimentFixtures } from './decision-experiment-fixtures'

function correctResult(request: DecisionRequest): DecisionResult {
  const fixture = decisionExperimentFixtures.find(
    (entry) => JSON.stringify(entry.request.state) === JSON.stringify(request.state)
  )!
  const question = request.questions.completeness!
  if (question.type !== 'score') {
    throw new Error('Expected the fixture score rubric')
  }
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    answers: {
      intent: {
        type: 'choice',
        choice: fixture.expected.intent,
        confidence: 1,
        probabilities: Object.fromEntries(
          ['inspect', 'modify', 'other'].map((key) => [
            key,
            Number(key === fixture.expected.intent)
          ])
        )
      },
      completeness: {
        type: 'score',
        score: fixture.expected.completeness,
        confidence: 1,
        legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])),
        probabilities: Object.fromEntries(
          question.criteria.map((_, index) => [
            String(index),
            Number(index === fixture.expected.completeness)
          ])
        )
      },
      requestsChange: { type: 'noul', noul: Number(fixture.expected.requestsChange) }
    },
    usage: { inputTokens: 1_000, outputTokens: 90_000 }
  }
}
function harness() {
  const evaluate = vi
    .fn<StructuredDecisionProvider['evaluate']>()
    .mockImplementation(async (request) => correctResult(request))
  return { evaluate, provider: { id: 'typesafe', evaluate }, enabled: true, execute: true }
}
function baseline(index: number): DecisionExperimentBaseline {
  return {
    suite: DECISION_EXPERIMENT_SUITE,
    fixtureId: decisionExperimentFixtures[index]!.id,
    fixtureFingerprint: decisionExperimentFixtures[index]!.fingerprint,
    measured: true,
    model: 'measured-baseline-1',
    latencyMs: 500,
    costUsd: 0.002
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  try {
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

describe('known-answer decision experiment', () => {
  it.each([
    {},
    { enabled: true },
    { execute: true },
    { enabled: false, execute: true },
    { enabled: true, execute: false }
  ])('requires both explicit opt-ins: %j', async (optIns) => {
    const { provider, evaluate } = harness()
    const report = await runDecisionExperiment({ provider, ...optIns })
    expect(report).toMatchObject({ status: 'not_run', reason: 'disabled', samples: [] })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it.each([
    { maxRequests: 0 },
    { maxRequests: 1.5 },
    { maxRequests: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: Infinity }
  ])('rejects an invalid experiment budget: %j', async (budget) => {
    const options = harness()
    expect(await runDecisionExperiment({ ...options, ...budget })).toMatchObject({
      status: 'not_run',
      reason: 'invalid_configuration',
      samples: []
    })
    expect(options.evaluate).not.toHaveBeenCalled()
  })

  it('caps calls at six, runs sequentially, and prices actual input usage with free output', async () => {
    const options = harness()
    let active = 0
    let peak = 0
    options.evaluate.mockImplementation((request) => {
      active++
      peak = Math.max(peak, active)
      return new Promise((resolve) =>
        setTimeout(() => {
          active--
          resolve(correctResult(request))
        }, 100)
      )
    })
    const pending = runDecisionExperiment({ ...options, maxRequests: 100 })
    await vi.advanceTimersByTimeAsync(600)
    const report = await pending
    expect(peak).toBe(1)
    expect(options.evaluate).toHaveBeenCalledTimes(6)
    expect(DECISION_EXPERIMENT_MAX_REQUESTS).toBe(6)
    for (const [request] of options.evaluate.mock.calls) {
      expect(request.model).toBe('jev-1.13.0')
      expect(Object.values(request.questions).map((question) => question.type)).toEqual([
        'choice',
        'score',
        'noul'
      ])
    }
    expect(report).toMatchObject({
      status: 'completed',
      reason: null,
      automaticPromotion: false,
      limits: {
        maxRequests: 6,
        concurrency: 1,
        maxCallMs: 5_000,
        maxExperimentMs: 30_000,
        retries: 0
      },
      gating: { calibrated: false, experimentalOnly: true },
      totals: {
        requests: 6,
        evaluated: 6,
        usage: { inputTokens: 6_000, outputTokens: 540_000 },
        meanLatencyMs: 100,
        disagreements: 0,
        deferred: 0,
        costCoverage: 'complete'
      },
      calibration: {
        status: 'insufficient_sample',
        representativeSample: false,
        sampleCountPerPrimitive: 6,
        confidenceIsCorrectnessProbability: false,
        meanBrier: { choice: 0, score: 0, noul: 0 }
      }
    })
    expect(DECISION_EXPERIMENT_TARIFF).toMatchObject({
      inputUsdPerMillion: 0.042,
      outputUsdPerMillion: 0
    })
    expect(report.totals.knownIncrementalCostUsd).toBeCloseTo((6_000 * 0.042) / 1_000_000, 12)
    expect(report.totals.totalIncrementalCostUsd).toBeCloseTo((6_000 * 0.042) / 1_000_000, 12)
    expect(report.samples.every((sample) => sample.metrics?.gate === 'observed')).toBe(true)
    expect(report.samples.every((sample) => sample.baseline === null)).toBe(true)
    expect(report.comparison).toMatchObject({
      matchedPairs: 0,
      meanCandidateMinusBaselineLatencyMs: null,
      meanCandidateMinusBaselineCostUsd: null,
      speedupEstablished: false,
      savingsEstablished: false
    })
  })

  it('reports disagreements and Brier errors while deferring low-confidence answers', async () => {
    const options = harness()
    options.evaluate.mockImplementation(async (request) => {
      const result = correctResult(request)
      result.answers.intent = {
        type: 'choice',
        choice: 'modify',
        confidence: 0.4,
        probabilities: { inspect: 0.4, modify: 0.5, other: 0.1 }
      }
      const score = result.answers.completeness!
      if (score.type !== 'score') {
        throw new Error('Expected a score answer')
      }
      result.answers.completeness = {
        ...score,
        score: 1,
        confidence: 0.4,
        probabilities: { 0: 0.5, 1: 0, 2: 0.5 }
      }
      result.answers.requestsChange = { type: 'noul', noul: 0.6 }
      return result
    })
    const report = await runDecisionExperiment({ ...options, maxRequests: 1 })
    expect(report.samples[0]!.metrics).toMatchObject({
      observations: {
        intent: {
          choice: 'modify',
          confidence: 0.4,
          probabilities: { inspect: 0.4, modify: 0.5, other: 0.1 }
        },
        completeness: { score: 1, confidence: 0.4, probabilities: { 0: 0.5, 1: 0, 2: 0.5 } },
        requestsChange: { probability: 0.6 }
      },
      disagreements: { intent: true, completeness: true, requestsChange: true, count: 3 },
      lowConfidence: { choice: true, score: true, noul: true },
      gate: 'defer',
      scoreAbsoluteError: 1
    })
    expect(report.calibration.meanBrier.choice).toBeCloseTo(0.62)
    expect(report.calibration.meanBrier.score).toBeCloseTo(0.5)
    expect(report.calibration.meanBrier.noul).toBeCloseTo(0.36)
    expect(report.totals).toMatchObject({ requests: 1, disagreements: 3, deferred: 1 })
    expect(report.automaticPromotion).toBe(false)
  })

  it('sanitizes failures, never retries them, and leaves total cost unknown for missing usage', async () => {
    const options = harness()
    options.evaluate
      .mockResolvedValueOnce(correctResult(decisionExperimentFixtures[0]!.request))
      .mockRejectedValueOnce(new Error('private-provider-body credential-sentinel'))
      .mockRejectedValueOnce(new DecisionProviderError('overloaded', true, 1))
    const report = await runDecisionExperiment({ ...options, maxRequests: 3 })
    expect(options.evaluate).toHaveBeenCalledTimes(3)
    expect(report.samples.slice(1)).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        reason: 'provider_error',
        usage: null,
        estimatedCostUsd: null,
        metrics: null
      }),
      expect.objectContaining({
        status: 'unavailable',
        reason: 'overloaded',
        usage: null,
        estimatedCostUsd: null,
        metrics: null
      })
    ])
    expect(report.totals).toMatchObject({
      requests: 3,
      evaluated: 1,
      unreportedUsageRequests: 2,
      costCoverage: 'partial',
      totalIncrementalCostUsd: null
    })
    expect(report.totals.knownIncrementalCostUsd).toBeCloseTo(0.000042, 12)
    expect(JSON.stringify(report)).not.toMatch(/private-provider-body|credential-sentinel/)
  })

  it.each([
    { answers: {} },
    { model: 'jev-1.12.0' },
    { provider: 'unexpected-provider' },
    { usage: { inputTokens: -1, outputTokens: 0 } }
  ])('rejects invalid provider results: %j', async (override) => {
    const options = harness()
    options.evaluate.mockResolvedValue({
      ...correctResult(decisionExperimentFixtures[0]!.request),
      ...override
    })
    const report = await runDecisionExperiment({ ...options, maxRequests: 1 })
    expect(report.samples[0]).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_response',
      usage: null,
      metrics: null
    })
    expect(report.totals.totalIncrementalCostUsd).toBeNull()
  })

  it.each([700, 5_000, 60_000])(
    'enforces at most five seconds despite an uncooperative provider: %i',
    async (timeoutMs) => {
      const options = harness()
      let resolveLate!: (result: DecisionResult) => void
      options.evaluate.mockReturnValue(
        new Promise((resolve) => {
          resolveLate = resolve
        })
      )
      const pending = runDecisionExperiment({ ...options, timeoutMs })
      await Promise.resolve()
      const signal = options.evaluate.mock.calls[0]![1].signal
      const deadline = Math.min(timeoutMs, 5_000)
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const report = await pending
      expect(report).toMatchObject({
        status: 'stopped',
        reason: 'timeout',
        totals: { requests: 1 }
      })
      expect(report.samples[0]).toMatchObject({ latencyMs: deadline, reason: 'timeout' })
      expect(signal.aborted).toBe(true)
      resolveLate(correctResult(decisionExperimentFixtures[0]!.request))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(options.evaluate).toHaveBeenCalledTimes(1)
      expect(report.samples[0]!.status).toBe('unavailable')
    }
  )

  it.each(['before', 'in-flight'] as const)('honors caller cancellation %s', async (phase) => {
    const options = harness()
    const caller = new AbortController()
    options.evaluate.mockReturnValue(new Promise(() => undefined))
    if (phase === 'before') {
      caller.abort()
    }
    const pending = runDecisionExperiment({ ...options, signal: caller.signal })
    if (phase === 'in-flight') {
      await Promise.resolve()
      caller.abort(new Error('private-cancel-reason'))
    }
    const report = await pending
    expect(report).toMatchObject({ status: 'stopped', reason: 'cancelled' })
    expect(options.evaluate).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
    if (phase === 'in-flight') {
      expect(options.evaluate.mock.calls[0]![1].signal.aborted).toBe(true)
    }
    expect(JSON.stringify(report)).not.toContain('private-cancel-reason')
  })

  it('compares only unique, measured observations of the exact suite and fixture', async () => {
    const options = harness()
    options.evaluate.mockImplementation(
      (request) => new Promise((resolve) => setTimeout(() => resolve(correctResult(request)), 10))
    )
    const baselines = [
      baseline(0),
      baseline(1),
      baseline(1),
      { ...baseline(2), suite: 'different-suite' },
      { ...baseline(3), measured: false },
      { ...baseline(4), fixtureFingerprint: '0'.repeat(64) },
      { ...baseline(5), model: 'private model text' },
      { ...baseline(5), fixtureId: 'different-fixture' }
    ] as DecisionExperimentBaseline[]
    const pending = runDecisionExperiment({ ...options, baselines })
    await vi.advanceTimersByTimeAsync(60)
    const report = await pending
    expect(report.samples[0]!.baseline).toEqual({
      model: 'measured-baseline-1',
      latencyMs: 500,
      costUsd: 0.002
    })
    expect(report.samples.slice(1).every((sample) => sample.baseline === null)).toBe(true)
    expect(report.comparison).toMatchObject({
      matchedPairs: 1,
      meanCandidateMinusBaselineLatencyMs: -490,
      speedupEstablished: false,
      savingsEstablished: false
    })
    expect(report.comparison.meanCandidateMinusBaselineCostUsd).toBeCloseTo(0.000042 - 0.002, 12)
    expect(JSON.stringify(report)).not.toContain('private model text')
  })
})
