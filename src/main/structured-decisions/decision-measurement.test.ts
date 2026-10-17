import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DecisionRequest,
  DecisionResult,
  StructuredDecisionProvider
} from '../../shared/structured-decisions'
import type { DecisionConfiguration } from './decision-configuration'
import { DecisionService, type DecisionServiceOptions } from './decision-service'
import {
  DecisionTelemetry,
  type DecisionMeasurementContext,
  type DecisionTelemetryEvent
} from './decision-telemetry'

const PRIVATE = 'private-transcript-sentinel'
const services: DecisionService[] = []
const measurement = (): DecisionMeasurementContext => ({
  eventFingerprint: 'a'.repeat(64),
  eventReference: 'b'.repeat(64),
  baselineSource: 'recorded_verdict',
  evidenceScope: 'structural_metadata',
  projectionVersion: 'orchestration-structural-v2'
})
const probabilities = () => ({
  pass: 0.7,
  findings: 0.1,
  fail: 0.1,
  insufficient_evidence: 0.05,
  crashed: 0.05
})
const request = (capability = 'orchestration.review'): DecisionRequest => ({
  capability,
  ...(capability === 'routine.structured' ? { routineId: 'routine-1' } : {}),
  state: { transcript: PRIVATE },
  questions: {
    classification: {
      type: 'choice',
      instructions: PRIVATE,
      criteria: Object.fromEntries(Object.keys(probabilities()).map((label) => [label, label]))
    }
  }
})
const result = (): DecisionResult => ({
  provider: 'fake',
  model: 'fake-1',
  usage: { inputTokens: 10, outputTokens: 2 },
  answers: {
    classification: {
      type: 'choice',
      choice: 'pass',
      probabilities: probabilities(),
      confidence: 0.8
    }
  }
})
const event = (): DecisionTelemetryEvent => ({
  timestamp: 1,
  capability: 'orchestration.review',
  mode: 'shadow',
  status: 'success',
  elapsedMs: 1,
  attempts: 1,
  measurement: measurement(),
  choices: {
    classification: { value: 'pass', baselineValue: 'fail', probabilities: probabilities() }
  }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness(options: Partial<DecisionServiceOptions> = {}) {
  const configuration: DecisionConfiguration = {
    version: 1,
    valid: true,
    enabled: true,
    killSwitch: false,
    timeoutMs: 1_000,
    capabilities: {
      'orchestration.review': { mode: 'shadow' },
      'routine.structured': { mode: 'live' }
    },
    routines: { 'routine-1': { mode: 'live' } }
  }
  const evaluate = vi.fn<StructuredDecisionProvider['evaluate']>().mockResolvedValue(result())
  const service = new DecisionService({
    provider: { id: 'fake', evaluate },
    configuration: () => configuration,
    environment: () => ({}),
    ...options
  })
  services.push(service)
  return { service, evaluate }
}
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  vi.setSystemTime(0)
})
afterEach(async () => {
  services.splice(0).forEach((service) => service.dispose())
  try {
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

describe('bounded decision measurement metadata', () => {
  it('snapshots admitted context and baseline without private content', async () => {
    const append = vi.fn().mockResolvedValue(undefined)
    const { service } = harness({ telemetry: new DecisionTelemetry({ append }) })
    const context = { ...measurement(), transcript: PRIVATE }
    const comparison = { classification: 'fail', extra: PRIVATE }
    service.observeShadow(request(), { comparison, measurement: context })
    context.eventFingerprint = 'c'.repeat(64)
    context.eventReference = 'd'.repeat(64)
    comparison.classification = 'pass'
    await settle()
    const recorded = service.telemetry.snapshot()[0]!
    expect(recorded.measurement).toEqual(measurement())
    expect(recorded.choices).toEqual({
      classification: {
        value: 'pass',
        confidence: 0.8,
        matches: false,
        baselineValue: 'fail',
        probabilities: probabilities()
      }
    })
    expect(JSON.stringify([recorded, append.mock.calls])).not.toContain(PRIVATE)
    recorded.choices!.classification!.probabilities!.pass = 0
    expect(service.telemetry.snapshot()[0]!.choices!.classification!.probabilities).toEqual(
      probabilities()
    )
  })

  it('preserves choice output without measurement context', async () => {
    const { service } = harness()
    service.observeShadow(request(), { comparison: { classification: 'pass' } })
    await settle()
    expect(service.telemetry.snapshot()[0]!.choices).toEqual({
      classification: { value: 'pass', confidence: 0.8, matches: true }
    })
    expect(service.telemetry.snapshot()[0]).not.toHaveProperty('measurement')
  })

  it.each([
    { ...probabilities(), pass: 0.1 },
    { ...probabilities(), pass: Number.NaN },
    { ...probabilities(), [PRIVATE]: 0 }
  ])('rejects malformed distributions at the telemetry boundary', (distribution) => {
    const telemetry = new DecisionTelemetry()
    const input = event()
    input.choices!.classification!.probabilities = distribution
    telemetry.record(input)
    expect(telemetry.snapshot()[0]!.choices!.classification).not.toHaveProperty('probabilities')
    expect(JSON.stringify(telemetry.snapshot())).not.toContain(PRIVATE)
  })

  it.each([
    'missing-context',
    'invalid-hash',
    'wrong-capability',
    'wrong-question',
    'unknown-baseline'
  ])('does not retain unrestricted measurement fields for %s', (scenario) => {
    const telemetry = new DecisionTelemetry()
    const input = event()
    if (scenario === 'missing-context') {
      delete input.measurement
    }
    if (scenario === 'invalid-hash') {
      input.measurement!.eventReference = PRIVATE
    }
    if (scenario === 'wrong-capability') {
      input.capability = 'routine.structured'
    }
    if (scenario === 'wrong-question') {
      input.choices = { other: input.choices!.classification! }
    }
    if (scenario === 'unknown-baseline') {
      input.choices!.classification!.baselineValue = PRIVATE
    }
    telemetry.record(input)
    const choice = Object.values(telemetry.snapshot()[0]!.choices!)[0]!
    expect(choice).not.toHaveProperty('baselineValue')
    if (scenario !== 'unknown-baseline') {
      expect(choice).not.toHaveProperty('probabilities')
    }
    expect(JSON.stringify(telemetry.snapshot())).not.toContain(PRIVATE)
  })
})

describe('decision admission and completion measurements', () => {
  it('counts successful, failed, gated, and invalid calls', async () => {
    const { service, evaluate } = harness()
    expect((await service.evaluate(request('routine.structured'))).status).toBe('evaluated')
    evaluate.mockRejectedValueOnce(new Error(PRIVATE))
    service.observeShadow(request())
    service.observeShadow({ ...request(), questions: {} })
    await service.evaluate({ ...request(), questions: {} })
    await service.evaluate(request())
    await settle()
    expect(service.telemetry.measurementSnapshot()).toMatchObject({
      admitted: 5,
      queued: 1,
      started: 3,
      completed: 3,
      cancelled: 0,
      dropped: 2,
      droppedInvalidRequest: 2,
      droppedQueueFull: 0,
      droppedDisposed: 0
    })
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it.each(['abortPending', 'dispose'] as const)(
    'counts queue losses during %s',
    async (operation) => {
      const { service, evaluate } = harness({ shadowConcurrency: 1, shadowQueueLimit: 1 })
      const pending = deferred<DecisionResult>()
      evaluate.mockReturnValueOnce(pending.promise)
      service.observeShadow(request())
      await settle()
      service.observeShadow(request())
      service.observeShadow(request())
      service[operation]()
      await settle()
      pending.resolve(result())
      await settle()
      expect(service.telemetry.measurementSnapshot()).toMatchObject({
        admitted: 3,
        queued: 2,
        started: 1,
        completed: 1,
        cancelled: 1,
        dropped: 2,
        droppedQueueFull: 1,
        droppedQueueCleared: 1
      })
      expect(evaluate).toHaveBeenCalledTimes(1)
      if (operation === 'dispose') {
        service.observeShadow(request())
        await service.evaluate(request('routine.structured'))
        expect(service.telemetry.measurementSnapshot()).toMatchObject({
          admitted: 5,
          started: 2,
          completed: 2,
          dropped: 3,
          droppedDisposed: 1
        })
        expect(await service.evaluate({ ...request(), questions: {} })).toEqual({
          status: 'unavailable',
          reason: 'invalid_request'
        })
        expect(service.telemetry.measurementSnapshot()).toMatchObject({
          admitted: 6,
          started: 2,
          completed: 2,
          dropped: 4,
          droppedInvalidRequest: 1
        })
      }
    }
  )

  it('counts caller cancellation separately from timeout', async () => {
    const { service, evaluate } = harness()
    evaluate.mockReturnValue(deferred<DecisionResult>().promise)
    const caller = new AbortController()
    service.observeShadow(request(), { signal: caller.signal })
    await settle()
    caller.abort()
    await settle()
    service.observeShadow(request())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(service.telemetry.measurementSnapshot()).toMatchObject({
      admitted: 2,
      queued: 2,
      started: 2,
      completed: 2,
      cancelled: 1,
      dropped: 0
    })
    expect(service.telemetry.snapshot().map((entry) => entry.reason)).toEqual([
      'cancelled',
      'timeout'
    ])
  })
})

describe('measurement retention and persistence accounting', () => {
  it('separates ring eviction from append outcomes', async () => {
    const blocked = deferred<void>()
    const append = vi
      .fn()
      .mockReturnValueOnce(blocked.promise)
      .mockRejectedValueOnce(new Error(PRIVATE))
    const telemetry = new DecisionTelemetry({ capacity: 1, append })
    telemetry.record(event())
    telemetry.record(event())
    telemetry.record(event())
    expect(telemetry.measurementSnapshot()).toMatchObject({
      ringEvicted: 2,
      appendDropped: 1,
      appendSucceeded: 0,
      appendFailed: 0,
      dropped: 0
    })
    blocked.resolve()
    await settle()
    expect(telemetry.measurementSnapshot()).toMatchObject({
      ringEvicted: 2,
      appendDropped: 1,
      appendSucceeded: 1,
      appendFailed: 1,
      dropped: 0
    })
    expect(append).toHaveBeenCalledTimes(2)
    expect(telemetry.snapshot()).toHaveLength(1)
  })
})
