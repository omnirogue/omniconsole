import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import { renderRoutedSessionPrepPrompt } from './session-prep-dispatch-route'
import { routedDecision, sessionPrepItemLaunchChoice } from './session-prep-launch-choice'

const decision = {
  provider: 'codex' as const,
  model: 'gpt-6-luna',
  effort: 'medium' as const,
  tier: 'fast',
  gate: 'jev',
  reason: 'Bounded',
  note: ''
}

function fixture(mode: 'off' | 'shadow' | 'live') {
  const routeDispatch = vi.fn().mockResolvedValue(decision)
  const discoverRouteModels = vi
    .fn()
    .mockResolvedValue({ hostId: 'local', observedAt: 1, agents: [] })
  const host = {
    isAgentEnabled: () => true,
    routeDispatch,
    discoverRouteModels
  } as unknown as SessionPrepHost
  const item = { index: 0, planned: { title: 'Task' } } as SessionPrepItemRecord
  const batch = { source: { agent: 'claude', routingMode: mode } } as SessionPrepBatchRecord
  const run = () =>
    renderRoutedSessionPrepPrompt(
      { host, now: () => 1 },
      batch,
      item,
      null,
      (launch) => `${launch.agent}:${launch.model ?? 'default'}`
    )
  return { host, item, run, routeDispatch, discoverRouteModels }
}
afterEach(() => vi.unstubAllEnvs())

describe('routing mode application and persisted decisions', () => {
  it('off skips discovery and classification', async () => {
    const f = fixture('off')
    expect(await f.run()).toBe('claude:default')
    expect(f.discoverRouteModels).not.toHaveBeenCalled()
    expect(f.routeDispatch).not.toHaveBeenCalled()
    expect(f.item.route).toMatchObject({ status: 'off', mode: 'off' })
  })

  it.each([undefined, 'high'] as const)(
    'skips discovery and classification for a named model with effort %s',
    async (effort) => {
      const f = fixture('live')
      f.item.planned.choices = {
        agent: 'codex',
        model: 'gpt-6-astra',
        ...(effort ? { effort } : {})
      }
      // A previously blocked automatic receipt must not prevent the explicit launch adapter path.
      f.item.route = {
        status: 'unavailable',
        unrouted: 'Old discovery failed',
        blocking: true,
        mode: 'live',
        at: 0
      }
      expect(await f.run()).toBe('codex:gpt-6-astra')
      expect(f.discoverRouteModels).not.toHaveBeenCalled()
      expect(f.routeDispatch).not.toHaveBeenCalled()
      expect(f.item.route).toMatchObject({ status: 'pinned', requested: { model: 'gpt-6-astra' } })
    }
  )

  it.each(['off', 'shadow'] as const)('host %s suppresses a saved live choice', async (mode) => {
    const f = fixture('live')
    f.item.route = { ...decision, mode: 'live', at: 0 }
    f.host.routingMode = () => mode
    expect(await f.run()).toBe('claude:default')
    expect(routedDecision(f.item, mode)).toBeUndefined()
    expect(
      sessionPrepItemLaunchChoice(
        f.host,
        { source: { agent: 'claude' } } as SessionPrepBatchRecord,
        f.item,
        null
      ).routedModel
    ).toBeUndefined()
    expect(f.routeDispatch).not.toHaveBeenCalled()
  })

  it('a live host does not promote a persisted shadow recommendation', async () => {
    const f = fixture('live')
    f.item.route = { ...decision, mode: 'shadow', at: 0 }
    f.host.routingMode = () => 'live'
    expect(await f.run()).toBe('claude:default')
    expect(routedDecision(f.item, 'live')).toBeUndefined()
  })

  it('host off overrides live intake and suppresses a prior blocking receipt', async () => {
    const f = fixture('live')
    f.host.routingMode = () => 'off'
    expect(await f.run()).toBe('claude:default')
    expect(f.item.route).toMatchObject({ status: 'off', mode: 'off' })
    expect(f.discoverRouteModels).not.toHaveBeenCalled()
    expect(f.routeDispatch).not.toHaveBeenCalled()
    f.item.route = {
      status: 'unavailable',
      unrouted: 'Missing automatic candidate',
      blocking: true,
      mode: 'live',
      at: 0
    }
    expect(await f.run()).toBe('claude:default')
  })

  it('shadow persists the recommendation without changing the launch', async () => {
    const f = fixture('shadow')
    expect(await f.run()).toBe('claude:default')
    expect(f.item.route).toMatchObject({ ...decision, mode: 'shadow' })
    expect(routedDecision(f.item)).toBeUndefined()
  })

  it('live applies once and reuses the decision when resumed', async () => {
    const f = fixture('live')
    expect(await f.run()).toBe('codex:gpt-6-luna')
    expect(await f.run()).toBe('codex:gpt-6-luna')
    expect(f.routeDispatch).toHaveBeenCalledOnce()
    expect(f.discoverRouteModels).toHaveBeenCalledOnce()
  })

  it('a blocking availability result holds the launch but shadow does not', async () => {
    const live = fixture('live')
    live.routeDispatch.mockResolvedValue({
      status: 'unavailable',
      blocking: true,
      unrouted: 'Missing pin'
    })
    await expect(live.run()).rejects.toThrow('Missing pin')
    expect(live.item.route).toMatchObject({ unrouted: 'Missing pin', at: 1 })
    const shadow = fixture('shadow')
    shadow.routeDispatch.mockResolvedValue({
      status: 'unavailable',
      blocking: true,
      unrouted: 'Missing pin'
    })
    expect(await shadow.run()).toBe('claude:default')
  })
})
