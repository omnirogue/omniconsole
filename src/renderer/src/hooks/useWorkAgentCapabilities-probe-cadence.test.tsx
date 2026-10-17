// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../shared/tui-agent'

const mocks = vi.hoisted(() => ({
  scope: 0,
  settings: null as GlobalSettings | null,
  detected: ['claude', 'codex', 'grok'] as TuiAgent[],
  rates: {} as Record<string, ProviderRateLimits>,
  discovery: vi.fn(),
  continuation: {
    available: false,
    loading: false,
    openrouterRouting: false,
    reason: undefined,
    refresh: async () => ({ available: false })
  }
}))

vi.mock('@/components/handoffs/handoff-scope', () => ({
  useHandoffScope: () => `cadence-test-${mocks.scope}`
}))
vi.mock('@/components/build-review/use-build-review-agent-models', () => ({
  resolveBuildReviewDiscoveryContext: () => ({ runtime: { kind: 'test-runtime' } })
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.discovery
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => mocks.detected.map((id) => ({ id, name: id }))
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => {
  const getState = () => ({
    settings: mocks.settings,
    rateLimits: mocks.rates,
    folderWorkspaces: [],
    getKnownWorktreeById: () => ({ linkedWorkItem: {} })
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    )
  }
})
vi.mock('./useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('./useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: mocks.detected,
    isLoading: false,
    refresh: async () => mocks.detected
  })
}))
vi.mock('./useWorkProviderUsage', () => ({
  refreshWorkProviderUsage: vi.fn(async () => undefined),
  useWorkProviderUsage: () => ({ rates: null, refresh: async () => null })
}))
vi.mock('./useTaskContinuationCapability', () => ({
  useTaskContinuationCapability: () => mocks.continuation
}))

import { useWorkAgentCapabilities } from './useWorkAgentCapabilities'
import {
  LEGACY_WORK_AGENT_MODEL_PROBE_DUE_MS,
  LEGACY_WORK_AGENT_MODEL_PROBE_TTL_MS,
  resetWorkAgentModelProbesForTests,
  WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS,
  WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS,
  WORK_AGENT_MODEL_PROBE_TTL_MS
} from './work-agent-model-probes'

type Listing = { success: true; catalogOrigin: 'probe'; models: { id: string; label: string }[] }
type PendingListing = { promise: Promise<Listing>; resolve: (value: Listing) => void }

function listing(agent: TuiAgent): Listing {
  const id = agent === 'codex' ? 'gpt-6-astra' : agent === 'grok' ? 'grok-4.6' : 'opus[1m]'
  return { success: true, catalogOrigin: 'probe', models: [{ id, label: id }] }
}

function pendingListing(): PendingListing {
  let resolve!: (value: Listing) => void
  const promise = new Promise<Listing>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const probedAgents = () => mocks.discovery.mock.calls.map(([, agent]) => agent as TuiAgent)
/** Agents whose models come from a listing still inside its lifetime (usage is not under test). */
const listed = (value: ReturnType<typeof useWorkAgentCapabilities>) =>
  value.capabilities.filter((entry) => entry.modelsProbed).map(({ id }) => id)

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Usage read at this moment, so only a listing's age can take an agent away. */
function freshRates(): Record<string, ProviderRateLimits> {
  return Object.fromEntries(
    mocks.detected.map((agent) => [
      agent,
      {
        provider: agent as ProviderRateLimits['provider'],
        status: 'ok',
        error: null,
        updatedAt: Date.now(),
        session: {
          usedPercent: 12,
          windowMinutes: 300,
          resetsAt: Date.now() + 60_000,
          resetDescription: null
        },
        weekly: null
      } as ProviderRateLimits
    ])
  )
}

type HostAnswer = Listing | { success: false; error: string }

/**
 * The execution host as main runs it: a good listing is answered from its record while the CLI
 * binary is unchanged, a failed one for five minutes unless a launch forces it; anything else
 * runs the CLI (a spawn).
 */
function hostWithRecord(answer: (agent: TuiAgent) => HostAnswer = listing) {
  const spawns: TuiAgent[] = []
  const binaries = new Map<TuiAgent, number>()
  const records = new Map<TuiAgent, { at: number; binary: number; value: HostAnswer }>()
  const discover = async (_runtime: unknown, agent: TuiAgent, options?: { force?: boolean }) => {
    const binary = binaries.get(agent) ?? 0
    const record = records.get(agent)
    const keepFor = record?.value.success ? 60 * 60_000 : 5 * 60_000
    if (
      record &&
      record.binary === binary &&
      Date.now() - record.at < keepFor &&
      (record.value.success || !options?.force)
    ) {
      return record.value
    }
    spawns.push(agent)
    const value = answer(agent)
    records.set(agent, { at: Date.now(), binary, value })
    return value
  }
  /** `claude update` and the like: a new binary, so its record no longer answers. */
  const update = (agent: TuiAgent) => binaries.set(agent, (binaries.get(agent) ?? 0) + 1)
  return { discover, spawns, update }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetWorkAgentModelProbesForTests()
  mocks.scope += 1
  mocks.detected = ['claude', 'codex', 'grok']
  mocks.rates = {}
  mocks.settings = getDefaultSettings('/tmp')
  mocks.discovery.mockImplementation(async (_runtime, agent: TuiAgent) => listing(agent))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('model listing cadence (quiet background agent runs)', () => {
  it('a launch click uses a fresh listing without starting another CLI probe', async () => {
    mocks.detected = ['codex']
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    let refreshed: Awaited<ReturnType<typeof result.current.refresh>> | undefined
    await act(async () => {
      refreshed = await result.current.refresh(['codex'])
    })
    expect(probedAgents()).toEqual(['codex'])
    expect(refreshed?.find((entry) => entry.id === 'codex')?.modelsProbed).toBe(true)
  })

  it('bounds a click behind a slow listing and uses the still-valid cached models', async () => {
    mocks.detected = ['codex']
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush()
    mocks.discovery.mockImplementation(() => new Promise(() => {}))
    await flush(WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS)
    rerender({ open: true })
    await flush()
    let refreshed: Awaited<ReturnType<typeof result.current.refresh>> | undefined
    await act(async () => {
      void result.current.refresh(['codex']).then((value) => {
        refreshed = value
      })
    })
    await flush(WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS)
    expect(probedAgents()).toEqual(['codex', 'codex'])
    expect(refreshed?.find((entry) => entry.id === 'codex')?.modelsProbed).toBe(true)
  })

  it('reports unavailability after the host actually returns no probe listing', async () => {
    mocks.detected = ['codex']
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush()
    mocks.discovery.mockResolvedValue({ success: false, error: 'unavailable' })
    await flush(WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS)
    rerender({ open: true })
    await flush()
    expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.modelsProbed).toBe(
      false
    )
  })

  it('lists each agent once on mount and never again on the minute tick', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok'])
    expect(result.current.loading).toBe(false)

    // Ten minute ticks: before, every tick re-ran the probe effect and re-listed each CLI.
    await flush(10 * 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    expect(listed(result.current)).toEqual(['claude', 'codex', 'grok'])
  })

  it('reuses a listing inside its lifetime and never lists again on a timer once it has passed', async () => {
    renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    // Another surface mounting inside the lifetime reuses the cached listing.
    renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush(WORK_AGENT_MODEL_PROBE_TTL_MS - 2 * 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(3)

    // Both stay mounted past the lifetime: nothing lists again with nobody opening anything.
    await flush(WORK_AGENT_MODEL_PROBE_TTL_MS + 3 * 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(3)

    // A surface without an open state of its own opens by mounting: it lists expired agents once.
    renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush(10 * 60_000)
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok'])
  })

  it('past its lifetime, a mounted launcher lists again only when it opens', async () => {
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush()
    expect(mocks.discovery).toHaveBeenCalledTimes(3)

    // Two lifetimes with the menu closed: nothing runs again, and the last listing stays on screen
    // until a new one replaces it. A click still reads it as expired and asks first.
    await flush(2 * WORK_AGENT_MODEL_PROBE_TTL_MS + 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    expect(listed(result.current)).toEqual(['claude', 'codex', 'grok'])
    expect(result.current.readCurrent().filter((entry) => entry.modelsProbed)).toEqual([])

    rerender({ open: true })
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok'])
    expect(listed(result.current)).toEqual(['claude', 'codex', 'grok'])
  })

  it('never retries a failed listing on a timer; a launcher opening asks the host again', async () => {
    mocks.discovery.mockImplementation(async (_runtime, agent: TuiAgent) =>
      agent === 'grok' ? { success: false, error: 'Grok is signed out.' } : listing(agent)
    )
    const { rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush()
    // Twenty minutes with the menu closed: the signed-out CLI is not run again.
    await flush(20 * 60_000)
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok'])

    // Opening asks the host for every agent; its own record keeps a failing CLI from running again.
    rerender({ open: true })
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok'])
  })

  it('behind the kill switch, re-lists a minute-old listing on the minute tick, as before', async () => {
    mocks.settings = { ...mocks.settings!, quietBackgroundAgentRuns: false }
    renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    await flush(LEGACY_WORK_AGENT_MODEL_PROBE_DUE_MS)
    expect(mocks.discovery).toHaveBeenCalledTimes(6)
  })

  it('behind the kill switch, a listing never reads expired between minute ticks', async () => {
    mocks.settings = { ...mocks.settings!, quietBackgroundAgentRuns: false }
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    // A listing taken between ticks (an explicit refresh 30 s in) must be re-listed on a tick
    // before its two-minute display lifetime runs out.
    await flush(30_000)
    await act(async () => {
      void result.current.refresh()
    })
    await flush()
    // Read as a click does, at that moment, not as the last render left it.
    const current = () =>
      result.current
        .readCurrent()
        .filter((entry) => entry.modelsProbed)
        .map(({ id }) => id)
    for (let elapsed = 0; elapsed < 2 * LEGACY_WORK_AGENT_MODEL_PROBE_TTL_MS; elapsed += 10_000) {
      await flush(10_000)
      expect(current()).toEqual(['claude', 'codex', 'grok'])
    }
  })

  it('behind the kill switch, listings run side by side as before', async () => {
    mocks.settings = { ...mocks.settings!, quietBackgroundAgentRuns: false }
    mocks.discovery.mockImplementation(() => pendingListing().promise)
    renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok'])
  })

  it('a launcher opening asks the host each time, whose record keeps the CLIs from running', async () => {
    const host = hostWithRecord()
    mocks.discovery.mockImplementation(host.discover)
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush(5 * 60_000)
    expect(host.spawns).toEqual(['claude', 'codex', 'grok'])

    // Listings five minutes old still go to the host on an opening; its record answers them.
    rerender({ open: true })
    await flush()
    expect(mocks.discovery).toHaveBeenCalledTimes(6)
    expect(host.spawns).toHaveLength(3)
    // A hover flicker (close and reopen within the floor) asks for nothing.
    rerender({ open: false })
    rerender({ open: true })
    await flush()
    expect(mocks.discovery).toHaveBeenCalledTimes(6)
    // Staying open across minute ticks does not list again either.
    await flush(5 * 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(6)

    // `claude update` brings a new model: the next opening shows it, running only that CLI.
    host.update('claude')
    mocks.discovery.mockImplementation((runtime, agent: TuiAgent, options) =>
      agent === 'claude'
        ? host.discover(runtime, agent, options).then(() => ({
            ...listing('claude'),
            models: [...listing('claude').models, { id: 'sonnet', label: 'sonnet' }]
          }))
        : host.discover(runtime, agent, options)
    )
    rerender({ open: false })
    rerender({ open: true })
    await flush()
    expect(host.spawns).toEqual(['claude', 'codex', 'grok', 'claude'])
    const claude = result.current.capabilities.find((entry) => entry.id === 'claude')
    expect(claude?.models.map(({ id }) => id)).toEqual(['opus[1m]', 'sonnet'])
  })

  it('a launch has the host run a CLI again whose listing it recorded as failed', async () => {
    let codexFails = true
    const host = hostWithRecord((agent) =>
      agent === 'codex' && codexFails
        ? { success: false, error: 'Codex token refresh failed.' }
        : listing(agent)
    )
    mocks.discovery.mockImplementation(host.discover)
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush(WORK_AGENT_MODEL_OPEN_REFRESH_FLOOR_MS)
    codexFails = false
    // An opening is answered from the host's record of the failure; Codex is not run again.
    rerender({ open: true })
    await flush()
    expect(host.spawns).toEqual(['claude', 'codex', 'grok'])

    // Choosing Codex to launch forces its listing; mounts and openings never did.
    let refreshed: Awaited<ReturnType<typeof result.current.refresh>> | undefined
    await act(async () => {
      void result.current.refresh(['codex']).then((value) => {
        refreshed = value
      })
    })
    await flush()
    expect(host.spawns).toEqual(['claude', 'codex', 'grok', 'codex'])
    expect(refreshed?.find((entry) => entry.id === 'codex')?.modelsProbed).toBe(true)
    expect(mocks.discovery.mock.calls.map((call) => call[2]?.force === true)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true
    ])
  })

  it('a surface without an open state keeps its last listing on screen past the lifetime', async () => {
    const { result, rerender } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    await flush(WORK_AGENT_MODEL_PROBE_TTL_MS + 5 * 60_000)
    // Nothing listed again with nobody opening anything...
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    // ...and every agent is still offered (the Attention strip, session model fields).
    mocks.rates = freshRates()
    rerender()
    expect(result.current.usable.map(({ id }) => id)).toEqual(['claude', 'codex', 'grok'])
    // A click still checks the age, so a launch asks for a new listing before it starts.
    expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.status).toBe(
      'model-unavailable'
    )
  })

  it('a re-list that gets no answer in time keeps the last good listing on screen', async () => {
    const { result, rerender } = renderHook(
      ({ open }) =>
        useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true, open),
      { initialProps: { open: false } }
    )
    await flush()
    // The host is busy (a restore sweep): nothing answers within the discovery timeout.
    mocks.discovery.mockImplementation(() => new Promise(() => {}))
    await flush(WORK_AGENT_MODEL_PROBE_TTL_MS + 60_000)
    rerender({ open: true })
    await flush(3 * WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS)
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok'])
    expect(listed(result.current)).toEqual(['claude', 'codex', 'grok'])
  })

  it('a long-lived surface re-lists expired agents when someone engages with it', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    const engage = async () => {
      await act(async () => {
        void result.current.refreshModels()
      })
      await flush()
    }
    // Inside the lifetime, engaging (pointer over the Attention strip) asks for nothing.
    await engage()
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    await flush(WORK_AGENT_MODEL_PROBE_TTL_MS + 60_000)
    expect(mocks.discovery).toHaveBeenCalledTimes(3)
    await engage()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok', 'claude', 'codex', 'grok'])
  })

  it('runs listings one at a time, never all agents in parallel', async () => {
    const pending = new Map<TuiAgent, PendingListing>()
    mocks.discovery.mockImplementation((_runtime, agent: TuiAgent) => {
      const next = pendingListing()
      pending.set(agent, next)
      return next.promise
    })
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    expect(probedAgents()).toEqual(['claude'])

    await act(async () => pending.get('claude')!.resolve(listing('claude')))
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex'])

    await act(async () => pending.get('codex')!.resolve(listing('codex')))
    await flush()
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok'])
    await act(async () => pending.get('grok')!.resolve(listing('grok')))
    await flush()
    expect(listed(result.current)).toEqual(['claude', 'codex', 'grok'])
  })

  it('answers within one discovery timeout while later listings still wait their turn', async () => {
    const claude = pendingListing()
    mocks.discovery.mockImplementation((_runtime, agent: TuiAgent) =>
      agent === 'claude' ? claude.promise : Promise.resolve(listing(agent))
    )
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush(15_000)
    // Claude timed out; the others were never stuck behind it past the person's wait.
    expect(result.current.loading).toBe(false)
    expect(probedAgents()).toEqual(['claude', 'codex', 'grok'])
    expect(listed(result.current)).toEqual(['codex', 'grok'])
  })

  it('refreshing the chosen agent waits for its real listing, not the queued placeholder', async () => {
    mocks.detected = ['codex', 'grok', 'claude']
    const grok = pendingListing()
    mocks.discovery.mockImplementation((_runtime, agent: TuiAgent) =>
      agent === 'codex'
        ? new Promise(() => {})
        : agent === 'grok'
          ? grok.promise
          : Promise.resolve(listing(agent))
    )
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush(WORK_AGENT_MODEL_DISCOVERY_TIMEOUT_MS)
    // Codex hung for its whole discovery timeout; grok runs now, and claude, still queued behind
    // it, reads as unavailable once its own wait ran out.
    expect(probedAgents()).toEqual(['codex', 'grok'])
    expect(listed(result.current)).toEqual([])

    let refreshed: Awaited<ReturnType<typeof result.current.refresh>> | undefined
    await act(async () => {
      void result.current.refresh(['claude']).then((value) => {
        refreshed = value
      })
    })
    expect(refreshed).toBeUndefined()
    await act(async () => grok.resolve(listing('grok')))
    await flush()
    expect(refreshed?.find((entry) => entry.id === 'claude')?.modelsProbed).toBe(true)
    // Only the chosen agent was listed for the launch.
    expect(probedAgents()).toEqual(['codex', 'grok', 'claude'])
  })

  it('moves the chosen agent ahead of listings still waiting their turn', async () => {
    mocks.detected = ['codex', 'grok', 'claude']
    const pending = new Map<TuiAgent, PendingListing>()
    mocks.discovery.mockImplementation((_runtime, agent: TuiAgent) => {
      const next = pendingListing()
      pending.set(agent, next)
      return next.promise
    })
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await flush()
    expect(probedAgents()).toEqual(['codex'])

    let refreshed: Awaited<ReturnType<typeof result.current.refresh>> | undefined
    await act(async () => {
      void result.current.refresh(['claude']).then((value) => {
        refreshed = value
      })
    })
    await act(async () => pending.get('codex')!.resolve(listing('codex')))
    await flush()
    expect(probedAgents()).toEqual(['codex', 'claude'])

    await act(async () => pending.get('claude')!.resolve(listing('claude')))
    await flush()
    expect(refreshed?.find((entry) => entry.id === 'claude')?.modelsProbed).toBe(true)
    expect(probedAgents()).toEqual(['codex', 'claude', 'grok'])
  })
})
