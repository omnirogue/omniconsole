import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DecisionRequest,
  DecisionResult,
  StructuredDecisionProvider
} from '../../shared/structured-decisions'
import { DECISION_KILL_ENV, type DecisionConfiguration } from './decision-configuration'
import { DecisionService, type DecisionServiceOptions } from './decision-service'
import { DecisionTelemetry } from './decision-telemetry'

const PRIVATE = 'private transcript or credential sentinel'
const capabilities = [
  'orchestration.judge',
  'orchestration.review',
  'orchestration.adversarial_review',
  'orchestration.verify',
  'orchestration.routing',
  'orchestration.handoff',
  'orchestration.done_when',
  'orchestration.tool_action',
  'orchestration.error_classification'
]
const services: DecisionService[] = []
const request = (capability = 'orchestration.judge'): DecisionRequest => ({
  capability,
  state: { outcome: { status: 'running' }, transcript: PRIVATE },
  questions: {
    decision: {
      type: 'choice',
      instructions: PRIVATE,
      criteria: { continue: 'Continue', stop: 'Stop' }
    }
  }
})
const result = (): DecisionResult => ({
  provider: 'fake',
  model: 'fake-1',
  requestId: 'request-1',
  answers: {
    decision: {
      type: 'choice',
      choice: 'continue',
      probabilities: { continue: 0.9, stop: 0.1 },
      confidence: 0.8
    }
  },
  usage: { inputTokens: 20, outputTokens: 4 }
})
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness(
  options: Partial<Omit<DecisionServiceOptions, 'provider' | 'configuration'>> = {},
  timeoutMs = 5_000
) {
  const config: DecisionConfiguration = {
    version: 1,
    valid: true,
    enabled: true,
    killSwitch: false,
    timeoutMs,
    capabilities: Object.fromEntries(
      capabilities.map((capability) => [capability, { mode: 'live' as const }])
    ),
    routines: {}
  }
  const evaluate = vi.fn<StructuredDecisionProvider['evaluate']>().mockResolvedValue(result())
  const service = new DecisionService({
    provider: { id: 'fake', evaluate },
    configuration: async () => config,
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

describe('DecisionService shadow isolation', () => {
  it.each(capabilities)(
    'forces %s into shadow even when configuration requests live',
    async (capability) => {
      const { service, evaluate } = harness()
      expect(await service.evaluate(request(capability))).toEqual({
        status: 'disabled',
        reason: 'shadow_only'
      })
      expect(evaluate).not.toHaveBeenCalled()
      const observation: void = service.observeShadow(request(capability))
      expect(observation).toBeUndefined()
      await settle()
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(service.telemetry.snapshot()).toEqual([
        expect.objectContaining({ mode: 'live', status: 'disabled', reason: 'shadow_only' }),
        expect.objectContaining({ mode: 'shadow', status: 'success' })
      ])
    }
  )

  it('returns void immediately and protects authoritative objects from provider mutation', async () => {
    const { service, evaluate } = harness()
    const authoritative = request()
    const before = structuredClone(authoritative)
    const comparison = { decision: 'stop' }
    evaluate.mockImplementation(async (input) => {
      expect(input).not.toBe(authoritative)
      expect(() => {
        ;(input.state as { outcome: { status: string } }).outcome.status = 'done'
      }).toThrow()
      expect(() => {
        input.questions.decision!.instructions = 'changed'
      }).toThrow()
      return result()
    })
    expect(service.observeShadow(authoritative, { comparison })).toBeUndefined()
    expect(evaluate).not.toHaveBeenCalled()
    expect(authoritative).toEqual(before)
    await settle()
    expect(authoritative).toEqual(before)
    expect(comparison).toEqual({ decision: 'stop' })
    expect(service.telemetry.snapshot()[0]).toMatchObject({
      status: 'success',
      choices: { decision: { value: 'continue', confidence: 0.8, matches: false } }
    })
  })

  it('snapshots state and comparisons before queueing rather than observing later caller edits', async () => {
    const { service, evaluate } = harness()
    const input = request()
    const state = input.state as { outcome: { status: string } }
    const comparison = { decision: 'continue' }
    service.observeShadow(input, { comparison })
    state.outcome.status = 'done'
    comparison.decision = 'stop'
    await settle()
    expect(evaluate.mock.calls[0]![0].state).toMatchObject({ outcome: { status: 'running' } })
    expect(service.telemetry.snapshot()[0]?.choices?.decision?.matches).toBe(true)
  })

  it('isolates malformed observations and rejected providers from authoritative callers', async () => {
    const { service, evaluate } = harness()
    expect(() => service.observeShadow({ ...request(), questions: {} })).not.toThrow()
    const input = request()
    const before = structuredClone(input)
    evaluate.mockRejectedValueOnce(new Error(PRIVATE))
    expect(service.observeShadow(input)).toBeUndefined()
    await settle()
    expect(input).toEqual(before)
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(service.telemetry.snapshot()).toEqual([
      expect.objectContaining({ status: 'unavailable', reason: 'provider_error' })
    ])
    expect(JSON.stringify(service.telemetry.snapshot())).not.toContain(PRIVATE)
  })

  it('keeps telemetry bounded and content-free even when persistence rejects', async () => {
    const append = vi.fn().mockRejectedValue(new Error(PRIVATE))
    const telemetry = new DecisionTelemetry({ capacity: 2, append })
    const { service } = harness({ telemetry })
    for (let index = 0; index < 3; index++) {
      service.observeShadow(request(), { comparison: { decision: 'stop', extra: PRIVATE } })
      await settle()
    }
    expect(append).toHaveBeenCalledTimes(3)
    expect(telemetry.snapshot()).toHaveLength(2)
    expect(telemetry.snapshot().every((event) => event.status === 'success')).toBe(true)
    const persisted = JSON.stringify(append.mock.calls)
    expect(persisted).not.toContain(PRIVATE)
    expect(persisted).not.toContain('instructions')
    expect(persisted).not.toContain('transcript')
    expect(persisted).not.toContain('probabilities')
    const snapshot = telemetry.snapshot()
    snapshot[0]!.choices!.decision!.value = 'changed'
    expect(telemetry.snapshot()[0]!.choices!.decision!.value).toBe('continue')
  })
})

describe('DecisionService shadow queue limits', () => {
  it('can repeatedly kill and re-enable shadow work without accepting late results', async () => {
    const environment: Record<string, string | undefined> = {}
    const { service, evaluate } = harness({ environment: () => environment })
    for (let cycle = 0; cycle < 2; cycle++) {
      const pending = deferred<DecisionResult>()
      evaluate.mockReturnValueOnce(pending.promise)
      service.observeShadow(request())
      await settle()
      environment[DECISION_KILL_ENV] = '1'
      await vi.advanceTimersByTimeAsync(250)
      expect(evaluate.mock.calls[cycle * 2]![1].signal.aborted).toBe(true)
      pending.resolve(result())
      await settle()
      expect(service.telemetry.snapshot().at(-1)?.status).toBe('disabled')
      environment[DECISION_KILL_ENV] = '0'
      service.observeShadow(request())
      await settle()
      expect(service.telemetry.snapshot().at(-1)?.status).toBe('success')
    }
    expect(evaluate).toHaveBeenCalledTimes(4)
    expect(service.telemetry.snapshot().map((event) => event.status)).toEqual([
      'disabled',
      'success',
      'disabled',
      'success'
    ])
  })

  it('bounds waiting jobs and starts only one provider call per concurrency slot', async () => {
    const { service, evaluate } = harness({ shadowConcurrency: 1, shadowQueueLimit: 2 })
    const first = deferred<DecisionResult>()
    const second = deferred<DecisionResult>()
    evaluate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    service.observeShadow(request())
    await settle()
    service.observeShadow(request())
    service.observeShadow(request())
    service.observeShadow(request())
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(service.telemetry.snapshot()).toEqual([
      expect.objectContaining({ status: 'dropped', reason: 'queue_full', attempts: 0 })
    ])
    first.resolve(result())
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(2)
    second.resolve(result())
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(service.telemetry.snapshot().filter((event) => event.status === 'success')).toHaveLength(
      3
    )
  })

  it('enforces hard caps of four active calls and 32 waiting observations', async () => {
    const { service, evaluate } = harness({ shadowConcurrency: 10_000, shadowQueueLimit: 10_000 })
    evaluate.mockReturnValue(deferred<DecisionResult>().promise)
    for (let index = 0; index < 4; index++) {
      service.observeShadow(request())
    }
    await settle()
    for (let index = 0; index < 40; index++) {
      service.observeShadow(request())
    }
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(4)
    expect(service.telemetry.snapshot()).toHaveLength(8)
    expect(service.telemetry.snapshot().every((event) => event.reason === 'queue_full')).toBe(true)
  })

  it('does not send queued observations that were cancelled before their slot opened', async () => {
    const { service, evaluate } = harness({ shadowConcurrency: 1 })
    const first = deferred<DecisionResult>()
    const caller = new AbortController()
    evaluate.mockReturnValueOnce(first.promise)
    service.observeShadow(request())
    await settle()
    service.observeShadow(request(), { signal: caller.signal })
    caller.abort()
    first.resolve(result())
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(service.telemetry.snapshot()[1]).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
      attempts: 0
    })
  })

  it('charges queue wait time to the total request deadline', async () => {
    const { service, evaluate } = harness({ shadowConcurrency: 1 }, 1_000)
    const first = deferred<DecisionResult>()
    evaluate
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(deferred<DecisionResult>().promise)
    service.observeShadow(request())
    await settle()
    service.observeShadow(request())
    await vi.advanceTimersByTimeAsync(900)
    first.resolve(result())
    await settle()
    expect(evaluate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    expect(evaluate.mock.calls[1]![1].signal.aborted).toBe(true)
    expect(service.telemetry.snapshot()[1]).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      elapsedMs: 1_000
    })
  })

  it.each(['abortPending', 'dispose'] as const)(
    '%s clears queued work and blocks late results',
    async (operation) => {
      const { service, evaluate } = harness({ shadowConcurrency: 1 })
      const first = deferred<DecisionResult>()
      evaluate.mockReturnValueOnce(first.promise)
      service.observeShadow(request())
      await settle()
      service.observeShadow(request())
      service.observeShadow(request())
      service[operation]()
      await settle()
      first.resolve(result())
      await settle()
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(evaluate.mock.calls[0]![1].signal.aborted).toBe(true)
      expect(service.telemetry.snapshot().some((event) => event.status === 'success')).toBe(false)
      service.observeShadow(request())
      await settle()
      expect(evaluate).toHaveBeenCalledTimes(operation === 'abortPending' ? 2 : 1)
    }
  )
})
