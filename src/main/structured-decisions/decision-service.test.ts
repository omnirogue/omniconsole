import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DecisionProviderError,
  type DecisionFailureCode,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import {
  DECISION_KILL_ENV,
  type DecisionConfiguration,
  type DecisionConfigurationSource
} from './decision-configuration'
import { DecisionService, type DecisionServiceOptions } from './decision-service'

const services: DecisionService[] = []
const request = (capability = 'routine.structured'): DecisionRequest => ({
  capability,
  routineId: 'routine-1',
  state: { summary: 'private project content' },
  questions: {
    decision: {
      type: 'choice',
      instructions: 'Select an action',
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
const configuration = (overrides: Partial<DecisionConfiguration> = {}): DecisionConfiguration => ({
  version: 1,
  valid: true,
  enabled: true,
  killSwitch: false,
  timeoutMs: 5_000,
  capabilities: { 'routine.structured': { mode: 'live' }, 'advertising.routine': { mode: 'live' } },
  routines: { 'routine-1': { mode: 'live' } },
  ...overrides
})
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function harness(
  source: DecisionConfigurationSource = () => configuration(),
  options: Partial<Omit<DecisionServiceOptions, 'provider' | 'configuration'>> = {}
) {
  const evaluate = vi.fn<StructuredDecisionProvider['evaluate']>().mockResolvedValue(result())
  const service = new DecisionService({
    provider: { id: 'fake', evaluate },
    configuration: source,
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

describe('DecisionService live authority', () => {
  it.each([
    [{ enabled: false }, 'disabled'],
    [{ killSwitch: true }, 'disabled'],
    [{ valid: false }, 'invalid_configuration'],
    [{ capabilities: {} }, 'disabled'],
    [{ capabilities: { 'routine.structured': { mode: 'off' } } }, 'disabled'],
    [{ capabilities: { 'routine.structured': { mode: 'shadow' } } }, 'not_live'],
    [{ routines: {} }, 'routine_not_enabled'],
    [{ routines: { 'routine-1': { mode: 'shadow' } } }, 'routine_not_enabled']
  ] as [Partial<DecisionConfiguration>, DecisionFailureCode][])(
    'fails closed for configuration %j',
    async (override, reason) => {
      const { service, evaluate } = harness(() => configuration(override))
      expect(await service.evaluate(request())).toEqual({ status: 'disabled', reason })
      expect(evaluate).not.toHaveBeenCalled()
    }
  )

  it('fails closed when asynchronous configuration loading rejects', async () => {
    const { service, evaluate } = harness(async () => {
      throw new Error('private configuration failure')
    })
    expect(await service.evaluate(request())).toEqual({
      status: 'disabled',
      reason: 'invalid_configuration'
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it.each(['advertising.routine', 'routine.structured'])(
    'allows explicitly live routine capability %s',
    async (capability) => {
      const { service, evaluate } = harness()
      expect(await service.evaluate(request(capability))).toEqual({
        status: 'evaluated',
        mode: 'live',
        result: result()
      })
      expect(evaluate).toHaveBeenCalledTimes(1)
    }
  )

  it('requires a routine identity even when its capability is live', async () => {
    const input = request()
    delete input.routineId
    const { service, evaluate } = harness()
    expect(await service.evaluate(input)).toEqual({
      status: 'disabled',
      reason: 'routine_not_enabled'
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow'] as const)(
    'respects a profile %s override of a persisted live routine',
    async (mode) => {
      const { service, evaluate } = harness(
        () => configuration({ routines: { 'routine-1': { mode } } }),
        { routineMode: async () => 'live' as const }
      )
      expect(await service.evaluate(request())).toEqual({
        status: 'disabled',
        reason: 'routine_not_enabled'
      })
      expect(evaluate).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the persisted routine mode cannot be read', async () => {
    const { service, evaluate } = harness(undefined, {
      routineMode: async () => {
        throw new Error('offline')
      }
    })
    expect(await service.evaluate(request())).toEqual({
      status: 'disabled',
      reason: 'routine_not_enabled'
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it.each(['off', 'shadow'] as const)(
    'requires live persisted routine mode instead of %s',
    async (mode) => {
      const { service, evaluate } = harness(undefined, { routineMode: async () => mode })
      expect(await service.evaluate(request())).toEqual({
        status: 'disabled',
        reason: 'routine_not_enabled'
      })
      expect(evaluate).not.toHaveBeenCalled()
    }
  )

  it('reloads asynchronous configuration for subsequent evaluations', async () => {
    let current = configuration()
    const { service, evaluate } = harness(async () => current)
    expect((await service.evaluate(request())).status).toBe('evaluated')
    current = configuration({ enabled: false })
    expect(await service.evaluate(request())).toEqual({ status: 'disabled', reason: 'disabled' })
    current = configuration()
    expect((await service.evaluate(request())).status).toBe('evaluated')
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid input before calling the provider', async () => {
    const { service, evaluate } = harness()
    expect(await service.evaluate({ ...request(), questions: {} })).toEqual({
      status: 'unavailable',
      reason: 'invalid_request'
    })
    expect(evaluate).not.toHaveBeenCalled()
  })
})

describe('DecisionService deadlines and retry budget', () => {
  it('accepts a successful transient retry and records both attempts', async () => {
    const { service, evaluate } = harness()
    evaluate.mockRejectedValueOnce(new DecisionProviderError('overloaded', true, 100))
    const outcome = service.evaluate(request())
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toEqual({ status: 'evaluated', mode: 'live', result: result() })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(service.telemetry.snapshot()).toEqual([
      expect.objectContaining({ attempts: 2, status: 'success', elapsedMs: 100 })
    ])
  })

  it.each(['rate_limited', 'overloaded', 'network', 'provider_error', 'timeout'] as const)(
    'allows only one transient %s retry',
    async (code) => {
      const { service, evaluate } = harness()
      evaluate.mockRejectedValue(new DecisionProviderError(code, true, 100))
      const outcome = service.evaluate(request())
      await settle()
      expect(evaluate).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(evaluate).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toEqual({ status: 'unavailable', reason: code })
      expect(evaluate).toHaveBeenCalledTimes(2)
      expect(service.telemetry.snapshot()).toEqual([
        expect.objectContaining({ attempts: 2, status: 'unavailable', elapsedMs: 100 })
      ])
    }
  )

  it.each([
    'authentication',
    'forbidden',
    'invalid_request',
    'invalid_response',
    'no_api_key'
  ] as const)(
    'never retries a permanent %s failure even if the provider claims it is retryable',
    async (code) => {
      const { service, evaluate } = harness()
      evaluate.mockRejectedValue(new DecisionProviderError(code, true, 0))
      const outcome = service.evaluate(request())
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toEqual({ status: 'unavailable', reason: code })
      expect(evaluate).toHaveBeenCalledTimes(1)
    }
  )

  it('does not retry malformed success payloads or unknown errors', async () => {
    const { service, evaluate } = harness()
    evaluate.mockResolvedValueOnce({ ...result(), answers: {} })
    expect(await service.evaluate(request())).toEqual({
      status: 'unavailable',
      reason: 'invalid_response'
    })
    evaluate.mockRejectedValueOnce(new Error('private provider response body'))
    expect(await service.evaluate(request())).toEqual({
      status: 'unavailable',
      reason: 'provider_error'
    })
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(service.telemetry.snapshot())).not.toContain('private')
  })

  it.each([700, 5_000, 30_000])(
    'bounds the total deadline even for configured timeout %i ms',
    async (timeoutMs) => {
      const { service, evaluate } = harness(() => configuration({ timeoutMs }))
      const deadline = Math.min(timeoutMs, 5_000)
      const pending = deferred<DecisionResult>()
      evaluate.mockReturnValue(pending.promise)
      const outcome = service.evaluate(request())
      await settle()
      const signal = evaluate.mock.calls[0]![1].signal
      await vi.advanceTimersByTimeAsync(deadline - 1)
      expect(signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toEqual({ status: 'unavailable', reason: 'timeout' })
      expect(signal.aborted).toBe(true)
      pending.resolve(result())
      await settle()
      expect(service.telemetry.snapshot()).toEqual([
        expect.objectContaining({ status: 'unavailable', reason: 'timeout', elapsedMs: deadline })
      ])
    }
  )

  it('includes asynchronous configuration loading in the five second deadline', async () => {
    const pending = deferred<DecisionConfiguration>()
    const { service, evaluate } = harness(() => pending.promise)
    const outcome = service.evaluate(request())
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await outcome).toEqual({ status: 'unavailable', reason: 'timeout' })
    pending.resolve(configuration())
    await settle()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('shares one deadline across the first attempt, backoff, and retry', async () => {
    const { service, evaluate } = harness()
    evaluate
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new DecisionProviderError('overloaded', true, 150)), 4_600)
          })
      )
      .mockReturnValueOnce(deferred<DecisionResult>().promise)
    const outcome = service.evaluate(request())
    await vi.advanceTimersByTimeAsync(4_750)
    expect(evaluate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(250)
    expect(await outcome).toEqual({ status: 'unavailable', reason: 'timeout' })
    expect(service.telemetry.snapshot()).toEqual([
      expect.objectContaining({ attempts: 2, elapsedMs: 5_000 })
    ])
  })

  it.each([5_000, 60_000])(
    'refuses Retry-After %i ms when it consumes the remaining deadline',
    async (retryAfterMs) => {
      const { service, evaluate } = harness()
      evaluate.mockRejectedValue(new DecisionProviderError('rate_limited', true, retryAfterMs))
      expect(await service.evaluate(request())).toEqual({
        status: 'unavailable',
        reason: 'rate_limited'
      })
      expect(evaluate).toHaveBeenCalledTimes(1)
      expect(Date.now()).toBe(0)
    }
  )
})

describe('DecisionService cancellation and kill switches', () => {
  it.each(['before', 'in-flight', 'backoff'] as const)(
    'honors caller cancellation %s',
    async (phase) => {
      const { service, evaluate } = harness()
      const caller = new AbortController()
      if (phase === 'before') {
        caller.abort()
      } else if (phase === 'backoff') {
        evaluate.mockRejectedValue(new DecisionProviderError('overloaded', true, 1_000))
      } else {
        evaluate.mockReturnValue(deferred<DecisionResult>().promise)
      }
      const outcome = service.evaluate(request(), { signal: caller.signal })
      await settle()
      caller.abort()
      expect(await outcome).toEqual({ status: 'cancelled', reason: 'cancelled' })
      expect(evaluate).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['environment', 'configuration'] as const)(
    'cancels in-flight work when the %s kill switch turns on',
    async (kind) => {
      const environment: Record<string, string | undefined> = {}
      let current = configuration()
      const { service, evaluate } = harness(async () => current, { environment: () => environment })
      const pending = deferred<DecisionResult>()
      evaluate.mockReturnValue(pending.promise)
      const outcome = service.evaluate(request())
      await settle()
      if (kind === 'environment') {
        environment[DECISION_KILL_ENV] = '1'
      } else {
        current = configuration({ killSwitch: true })
      }
      await vi.advanceTimersByTimeAsync(250)
      expect(await outcome).toEqual({ status: 'disabled', reason: 'disabled' })
      expect(evaluate.mock.calls[0]![1].signal.aborted).toBe(true)
      pending.resolve(result())
      await settle()
      expect(service.telemetry.snapshot()).toEqual([
        expect.objectContaining({ status: 'disabled', reason: 'disabled' })
      ])
    }
  )

  it('checks a newly enabled kill switch before accepting a result between monitor ticks', async () => {
    let current = configuration()
    const { service, evaluate } = harness(async () => current)
    const pending = deferred<DecisionResult>()
    evaluate.mockReturnValue(pending.promise)
    const outcome = service.evaluate(request())
    await settle()
    current = configuration({ killSwitch: true })
    pending.resolve(result())
    expect(await outcome).toEqual({ status: 'disabled', reason: 'disabled' })
    expect(service.telemetry.snapshot().some((event) => event.status === 'success')).toBe(false)
  })

  it('checks the environment again after an asynchronous final configuration read', async () => {
    const environment: Record<string, string | undefined> = {}
    const pending = deferred<DecisionConfiguration>()
    const source = vi
      .fn<DecisionConfigurationSource>()
      .mockResolvedValueOnce(configuration())
      .mockResolvedValueOnce(configuration())
      .mockReturnValueOnce(pending.promise)
    const { service } = harness(source, { environment: () => environment })
    const outcome = service.evaluate(request())
    await settle()
    expect(source).toHaveBeenCalledTimes(3)
    environment[DECISION_KILL_ENV] = '1'
    pending.resolve(configuration())
    expect(await outcome).toEqual({ status: 'disabled', reason: 'disabled' })
    expect(Date.now()).toBe(0)
  })

  it('detects an environment kill while a previous monitor configuration read is stalled', async () => {
    const environment: Record<string, string | undefined> = {}
    const source = vi
      .fn<DecisionConfigurationSource>()
      .mockResolvedValueOnce(configuration())
      .mockResolvedValueOnce(configuration())
      .mockReturnValue(deferred<DecisionConfiguration>().promise)
    const { service, evaluate } = harness(source, { environment: () => environment })
    evaluate.mockReturnValue(deferred<DecisionResult>().promise)
    const outcome = service.evaluate(request())
    await vi.advanceTimersByTimeAsync(250)
    expect(source).toHaveBeenCalledTimes(3)
    environment[DECISION_KILL_ENV] = '1'
    await vi.advanceTimersByTimeAsync(250)
    expect(evaluate.mock.calls[0]![1].signal.aborted).toBe(true)
    expect(await outcome).toEqual({ status: 'disabled', reason: 'disabled' })
  })

  it('abortPending cancels current calls while leaving the service reusable', async () => {
    const { service, evaluate } = harness()
    evaluate.mockReturnValueOnce(deferred<DecisionResult>().promise)
    const first = service.evaluate(request())
    await settle()
    service.abortPending()
    expect(await first).toEqual({ status: 'disabled', reason: 'disabled' })
    expect(evaluate.mock.calls[0]![1].signal.aborted).toBe(true)
    expect((await service.evaluate(request())).status).toBe('evaluated')
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels current calls and permanently prevents new live work', async () => {
    const { service, evaluate } = harness()
    evaluate.mockReturnValue(deferred<DecisionResult>().promise)
    const first = service.evaluate(request())
    await settle()
    service.dispose()
    expect(await first).toEqual({ status: 'disabled', reason: 'disposed' })
    expect(await service.evaluate(request())).toEqual({ status: 'disabled', reason: 'disposed' })
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})
