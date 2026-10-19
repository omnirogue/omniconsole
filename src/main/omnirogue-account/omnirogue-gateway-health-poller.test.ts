import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomError } from '../rooms/room-error'
import {
  OmniRogueGatewayHealthPoller,
  type OmniRogueGatewayHealthPollerOptions,
  type OmniRogueGatewayHealthSnapshot
} from './omnirogue-gateway-health-poller'

const fullCatalog = {
  data: [
    { id: 'claude-opus-5-5', owned_by: 'anthropic' },
    { id: 'gpt-6-astra', owned_by: 'openai' },
    { id: 'gemini-4-argon', owned_by: 'google' }
  ]
}

function setup(
  request: OmniRogueGatewayHealthPollerOptions['request'],
  overrides: Partial<OmniRogueGatewayHealthPollerOptions> = {}
) {
  const published: OmniRogueGatewayHealthSnapshot[] = []
  const poller = new OmniRogueGatewayHealthPoller({
    request,
    publish: (snapshot) => published.push(snapshot),
    intervalMs: 60_000,
    retryBaseMs: 5_000,
    maxBackoffMs: 20_000,
    timeoutMs: 1_000,
    ...overrides
  })
  return { poller, published }
}

describe('OmniRogueGatewayHealthPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports healthy when every provider is listed and polls on the interval', async () => {
    const request = vi.fn(async () => fullCatalog)
    const { poller, published } = setup(request)
    expect(poller.current().state).toBe('unknown')
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledWith('/v1/models')
    expect(published).toEqual([
      {
        state: 'healthy',
        checkedAt: 1_000_000,
        latencyMs: 0,
        modelCount: 3,
        providers: ['anthropic', 'openai', 'google'],
        missingProviders: [],
        consecutiveFailures: 0,
        nextCheckMs: 60_000
      }
    ])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('reports degraded when a provider is missing from the live catalog', async () => {
    const { poller } = setup(async () => ({ data: fullCatalog.data.slice(0, 2) }))
    const snapshot = await poller.checkNow()
    expect(snapshot).toMatchObject({
      state: 'degraded',
      modelCount: 2,
      providers: ['anthropic', 'openai'],
      missingProviders: ['google'],
      nextCheckMs: null
    })
    expect(snapshot.error).toBeUndefined()
  })

  it.each([null, {}, { data: [] }, { data: [{ id: 'unknown-model' }] }])(
    'reports degraded instead of using fallback models for an unusable catalog: %j',
    async (body) => {
      const { poller } = setup(async () => body)
      expect(await poller.checkNow()).toMatchObject({
        state: 'degraded',
        modelCount: 0,
        providers: [],
        missingProviders: ['anthropic', 'openai', 'google'],
        error: 'invalid_response'
      })
    }
  )

  it.each(['device_unauthorized', 'forbidden'] as const)(
    'reports unauthorized for %s',
    async (code) => {
      const { poller } = setup(async () => {
        throw new RoomError(code)
      })
      expect(await poller.checkNow()).toMatchObject({
        state: 'unauthorized',
        error: code,
        consecutiveFailures: 1,
        modelCount: 0
      })
    }
  )

  it('backs off exponentially while unreachable and resets on recovery', async () => {
    let online = false
    const request = vi.fn(async () => {
      if (!online) {
        throw new Error('offline')
      }
      return fullCatalog
    })
    const { poller, published } = setup(request)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(published.map((snapshot) => [snapshot.state, snapshot.nextCheckMs])).toEqual([
      ['unreachable', 5_000],
      ['unreachable', 10_000],
      ['unreachable', 20_000],
      ['unreachable', 20_000]
    ])
    expect(published.at(-1)).toMatchObject({ consecutiveFailures: 4, error: 'network_error' })
    online = true
    await vi.advanceTimersByTimeAsync(20_000)
    expect(published.at(-1)).toMatchObject({
      state: 'healthy',
      consecutiveFailures: 0,
      nextCheckMs: 60_000
    })
    expect(published.at(-1)?.error).toBeUndefined()
    poller.dispose()
  })

  it('times out a request that never settles', async () => {
    const { poller } = setup(() => new Promise(() => undefined))
    const pending = poller.checkNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toMatchObject({
      state: 'unreachable',
      error: 'timeout',
      latencyMs: 1_000
    })
  })

  it('coalesces concurrent manual checks', async () => {
    const request = vi.fn(async () => fullCatalog)
    const { poller } = setup(request)
    const [first, second] = await Promise.all([poller.checkNow(), poller.checkNow()])
    expect(request).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('discards an in-flight result after stop and does not reschedule', async () => {
    let resolve: (value: unknown) => void = () => undefined
    const request = vi.fn(() => new Promise((done) => (resolve = done)))
    const { poller, published } = setup(request)
    poller.start()
    poller.stop()
    resolve(fullCatalog)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(published).toEqual([])
    expect(poller.current()).toMatchObject({ state: 'unknown', nextCheckMs: null })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh probe when restarted while a stale probe is in flight', async () => {
    const resolvers: ((value: unknown) => void)[] = []
    const request = vi.fn(() => new Promise((done) => resolvers.push(done)))
    const { poller, published } = setup(request)
    poller.start()
    poller.stop()
    poller.start()
    expect(request).toHaveBeenCalledTimes(2)
    resolvers[0]({})
    resolvers[1](fullCatalog)
    await vi.advanceTimersByTimeAsync(0)
    expect(published.map((snapshot) => snapshot.state)).toEqual(['healthy'])
    expect(poller.isRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(3)
    poller.dispose()
  })

  it('keeps polling when a publish listener throws', async () => {
    const request = vi.fn(async () => fullCatalog)
    const { poller } = setup(request, {
      publish: () => {
        throw new Error('window destroyed')
      }
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('reports no next check after a manual probe while stopped', async () => {
    const request = vi.fn(async () => fullCatalog)
    const { poller } = setup(request)
    expect((await poller.checkNow()).nextCheckMs).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(poller.isRunning()).toBe(false)
  })
})
