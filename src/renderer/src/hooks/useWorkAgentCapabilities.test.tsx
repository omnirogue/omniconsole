// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProviderRateLimits, RateLimitState } from '../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentDetectionTarget } from './useDetectedAgents'

type TestRates = Pick<RateLimitState, 'claude' | 'codex' | 'grok' | 'gemini' | 'kimiAuthConfigured'>

const mocks = vi.hoisted(() => ({
  scope: 0,
  settings: null as GlobalSettings | null,
  linkedTaskId: undefined as string | undefined,
  folders: [] as { id: string; linkedTask: { hubTaskId: string } }[],
  target: { kind: 'local' } as AgentDetectionTarget,
  rates: {} as TestRates,
  remoteRates: null as TestRates | null,
  detected: ['claude', 'codex', 'grok', 'gemini', 'claude-agent-teams'] as TuiAgent[],
  discovery: vi.fn(),
  refreshDetection: vi.fn(),
  refreshUsage: vi.fn(),
  refreshRemoteUsage: vi.fn(),
  taskContinuationCapabilities: vi.fn(),
  continueTask: vi.fn()
}))

vi.mock('@/components/handoffs/handoff-scope', () => ({
  useHandoffScope: () => `capability-test-${mocks.scope}`
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
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => {
  const getState = () => ({
    settings: mocks.settings,
    rateLimits: mocks.rates,
    folderWorkspaces: mocks.folders,
    getKnownWorktreeById: () => ({ linkedWorkItem: { hubTaskId: mocks.linkedTaskId } })
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    )
  }
})
vi.mock('./useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => mocks.target
}))
vi.mock('./useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: mocks.detected,
    isLoading: false,
    refresh: mocks.refreshDetection
  })
}))
vi.mock('./useWorkProviderUsage', () => ({
  refreshWorkProviderUsage: mocks.refreshUsage,
  useWorkProviderUsage: () => ({ rates: mocks.remoteRates, refresh: mocks.refreshRemoteUsage })
}))

import { useWorkAgentCapabilities, type WorkAgentCapabilityMode } from './useWorkAgentCapabilities'
import {
  resetWorkAgentModelProbesForTests,
  WORK_AGENT_MODEL_PROBE_TTL_MS
} from './work-agent-model-probes'

function availableUsage(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
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
  }
}

function discoveredModels(agent: TuiAgent) {
  if (agent === 'gemini') {
    return {
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }]
    }
  }
  const id = agent === 'codex' ? 'gpt-6-astra' : agent === 'grok' ? 'grok-4.6' : 'opus[1m]'
  return { success: true, catalogOrigin: 'probe', models: [{ id, label: id }] }
}

function setContinuationApi({ continueTask = true, capabilities = true } = {}) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      consoleLocalExecution: {
        ...(continueTask ? { continueTask: mocks.continueTask } : {}),
        ...(capabilities
          ? { taskContinuationCapabilities: mocks.taskContinuationCapabilities }
          : {})
      }
    }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function statuses(value: ReturnType<typeof useWorkAgentCapabilities>) {
  return Object.fromEntries(value.capabilities.map(({ id, status }) => [id, status]))
}

function expectWorkPlanRequired(value: ReturnType<typeof useWorkAgentCapabilities>) {
  expect(value.usable).toEqual([])
  expect(value.capabilities).toHaveLength(mocks.detected.length)
  expect(value.capabilities.every((entry) => entry.status === 'work-plan-required')).toBe(true)
  expect(value.capabilities.every((entry) => entry.models.length === 0)).toBe(true)
  expect(value.loading).toBe(false)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Why: listings share one app-wide queue; a test that leaves one hanging must not block the next.
  resetWorkAgentModelProbesForTests()
  mocks.detected = ['claude', 'codex', 'grok', 'gemini', 'claude-agent-teams']
  // Each scope gets independent evidence in the hook's private probe cache.
  mocks.scope += 1
  mocks.settings = getDefaultSettings('/tmp')
  mocks.linkedTaskId = undefined
  mocks.folders = []
  mocks.target = { kind: 'local' }
  mocks.rates = {
    claude: availableUsage('claude'),
    codex: availableUsage('codex'),
    grok: availableUsage('grok'),
    gemini: availableUsage('gemini')
  }
  mocks.remoteRates = null
  mocks.discovery.mockImplementation(async (_runtime, agent: TuiAgent) => discoveredModels(agent))
  mocks.refreshDetection.mockResolvedValue(mocks.detected)
  mocks.refreshUsage.mockResolvedValue(undefined)
  mocks.refreshRemoteUsage.mockImplementation(async () => mocks.remoteRates)
  mocks.taskContinuationCapabilities.mockReset()
  mocks.taskContinuationCapabilities.mockResolvedValue({ ok: true, data: { available: true } })
  setContinuationApi()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useWorkAgentCapabilities task continuation', () => {
  it('rechecks current account restrictions without launching a discovery probe', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.status).toBe(
      'usable'
    )
    const probeCount = mocks.discovery.mock.calls.length

    mocks.settings = { ...mocks.settings!, disabledTuiAgents: ['codex'] }
    expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.status).toBe(
      'disabled'
    )
    expect(mocks.discovery).toHaveBeenCalledTimes(probeCount)
    expect(mocks.refreshDetection).not.toHaveBeenCalled()
  })

  it('expires cached models at the click even before the periodic render refresh', async () => {
    // The earlier two-minute lifetime, kept behind the quiet background runs kill switch.
    mocks.settings = { ...mocks.settings!, quietBackgroundAgentRuns: false }
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001)
    try {
      expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.status).toBe(
        'model-unavailable'
      )
      expect(mocks.refreshDetection).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it('expires cached models at the click once the quiet probe lifetime has passed', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start + 120_001)
    try {
      const codex = () => result.current.readCurrent().find((entry) => entry.id === 'codex')
      expect(codex()?.status).toBe('usable')
      clock.mockReturnValue(start + WORK_AGENT_MODEL_PROBE_TTL_MS + 1)
      // Fresh usage at that moment, so the expired listing is the only thing that changed.
      mocks.rates = { ...mocks.rates, codex: availableUsage('codex') }
      expect(codex()?.status).toBe('model-unavailable')
      expect(mocks.refreshDetection).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })

  it('does not reuse another account model probe before a settings rerender', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    mocks.settings = { ...mocks.settings!, activeCodexManagedAccountId: 'new-account' }

    expect(result.current.readCurrent().find((entry) => entry.id === 'codex')?.status).toBe(
      'model-unavailable'
    )
  })

  it('honors a newly attached task before the sidebar rerenders', async () => {
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    mocks.linkedTaskId = 'new-task'

    expect(
      result.current.readCurrent().every((entry) => entry.status === 'work-plan-required')
    ).toBe(true)
  })

  it.each(['explicit task', 'linked worktree', 'linked folder'] as const)(
    'keeps ordinary workspace launches fenced for an %s even with the continuation API',
    (binding) => {
      if (binding === 'linked worktree') {
        mocks.linkedTaskId = 'task-1'
      }
      if (binding === 'linked folder') {
        mocks.folders = [{ id: 'folder-1', linkedTask: { hubTaskId: 'task-1' } }]
      }
      const { result } = renderHook(() =>
        useWorkAgentCapabilities(
          binding === 'linked folder' ? 'folder-1' : 'worktree-1',
          binding === 'explicit task' ? 'task-1' : undefined
        )
      )

      expectWorkPlanRequired(result.current)
      expect(mocks.discovery).not.toHaveBeenCalled()
      expect(mocks.taskContinuationCapabilities).not.toHaveBeenCalled()
    }
  )

  it('keeps an unbound workspace launch usable without querying continuation support', async () => {
    mocks.taskContinuationCapabilities.mockRejectedValue(new Error('Unsupported capability method'))
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(statuses(result.current)).toMatchObject({
      claude: 'usable',
      codex: 'usable',
      grok: 'usable'
    })
    expect(mocks.taskContinuationCapabilities).not.toHaveBeenCalled()
  })

  it('keeps agents with stale or missing usage selectable only in the Build + Review setup', async () => {
    mocks.rates.codex = { ...availableUsage('codex'), updatedAt: Date.now() - 360_001 }
    mocks.rates.grok = null
    // Cursor has no usage feed: no reading will ever arrive, so it is not waved through.
    mocks.detected = [...mocks.detected, 'cursor']
    const setup = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', undefined, 'build-review')
    )
    await waitFor(() => expect(setup.result.current.loading).toBe(false))
    const usable = (id: string) => setup.result.current.usable.find((entry) => entry.id === id)
    expect(usable('codex')).toMatchObject({ status: 'usable', usageUnchecked: true })
    expect(usable('codex')?.models.map(({ id }) => id)).toEqual(['gpt-6-astra'])
    expect(usable('grok')?.usageUnchecked).toBe(true)
    expect(usable('claude')).not.toHaveProperty('usageUnchecked')
    expect(statuses(setup.result.current).cursor).toBe('unverified')
    // Opening the setup asks the host for real readings; an explicit refresh says so.
    expect(mocks.refreshUsage).toHaveBeenCalledWith(expect.any(String))
    await act(() => setup.result.current.refresh())
    expect(mocks.refreshUsage).toHaveBeenLastCalledWith(expect.any(String), 'explicit')

    const launcher = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    await waitFor(() => expect(launcher.result.current.loading).toBe(false))
    expect(statuses(launcher.result.current)).toMatchObject({
      codex: 'unverified',
      grok: 'unverified'
    })
  })

  it.each(['explicit task', 'linked worktree', 'linked folder'] as const)(
    'negotiates continuation for the exact trimmed task from an %s',
    async (binding) => {
      if (binding === 'explicit task') {
        mocks.linkedTaskId = 'different-linked-task'
      } else if (binding === 'linked worktree') {
        mocks.linkedTaskId = '  task-1  '
      } else {
        mocks.folders = [{ id: 'folder-1', linkedTask: { hubTaskId: '  task-1  ' } }]
      }
      const { result } = renderHook(() =>
        useWorkAgentCapabilities(
          binding === 'linked folder' ? 'folder-1' : 'worktree-1',
          binding === 'explicit task' ? '  task-1  ' : '  ',
          'task-continuation'
        )
      )
      await waitFor(() => expect(result.current.usable).toHaveLength(4))

      expect(mocks.taskContinuationCapabilities).toHaveBeenCalledExactlyOnceWith({
        taskId: 'task-1'
      })
    }
  )

  it.each([
    ['continueTask', { continueTask: false }],
    ['taskContinuationCapabilities', { capabilities: false }]
  ] as const)(
    'keeps task continuation fenced when the host does not expose %s',
    async (_name, api) => {
      setContinuationApi(api)
      const { result } = renderHook(() =>
        useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
      )
      await waitFor(() => expectWorkPlanRequired(result.current))

      expect(mocks.discovery).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      'denied',
      { ok: true, data: { available: false, reason: 'Host has no continuation support' } }
    ],
    ['missing available', { ok: true, data: {} }],
    ['nonboolean available', { ok: true, data: { available: 'true' } }],
    ['malformed reason', { ok: true, data: { available: true, reason: 42 } }],
    ['missing data', { ok: true }],
    ['null data', { ok: true, data: null }],
    ['malformed response', null],
    ['failed result', { ok: false, error: { code: 'unavailable', message: 'Hub unavailable' } }]
  ])('requires explicit continuation support for a %s response', async (_name, response) => {
    mocks.taskContinuationCapabilities.mockResolvedValue(response)
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expectWorkPlanRequired(result.current))

    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('keeps task continuation fenced when capability negotiation rejects', async () => {
    mocks.taskContinuationCapabilities.mockRejectedValue(new Error('Connection lost'))
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expectWorkPlanRequired(result.current))

    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('waits for explicit host support before discovering models or offering continuation', async () => {
    const negotiation = deferred<unknown>()
    mocks.taskContinuationCapabilities.mockReturnValue(negotiation.promise)
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )

    expect(result.current.usable).toEqual([])
    expect(mocks.discovery).not.toHaveBeenCalled()
    await act(async () => {
      negotiation.resolve({ ok: true, data: { available: true } })
    })
    await waitFor(() => expect(result.current.usable).toHaveLength(4))

    expect(mocks.discovery).toHaveBeenCalled()
  })

  it('offers verified Claude, Codex, Grok and Gemini for continuation while fencing unsupported agents', async () => {
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(statuses(result.current)).toEqual({
      claude: 'usable',
      codex: 'usable',
      grok: 'usable',
      gemini: 'usable',
      'claude-agent-teams': 'work-plan-required'
    })
    expect(result.current.usable.map(({ id, models }) => [id, models[0]?.id])).toEqual([
      ['claude', 'opus[1m]'],
      ['codex', 'gpt-6-astra'],
      ['grok', 'grok-4.6'],
      ['gemini', 'gemini-3.8-flash']
    ])
    expect(mocks.taskContinuationCapabilities).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-1' })
    expect(mocks.continueTask).not.toHaveBeenCalled()
  })

  it('revokes prior continuation support while refreshing and keeps it revoked after denial', async () => {
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.usable).toHaveLength(4))
    const negotiation = deferred<unknown>()
    mocks.taskContinuationCapabilities.mockReturnValueOnce(negotiation.promise)
    mocks.discovery.mockClear()

    let refresh!: ReturnType<typeof result.current.refresh>
    act(() => {
      refresh = result.current.refresh()
    })
    expect(result.current.usable).toEqual([])
    expect(mocks.discovery).not.toHaveBeenCalled()

    await act(async () => {
      negotiation.resolve({ ok: true, data: { available: false } })
      const refreshed = await refresh
      expect(refreshed.every((entry) => entry.status === 'work-plan-required')).toBe(true)
    })

    expectWorkPlanRequired(result.current)
    expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(2)
    expect(mocks.taskContinuationCapabilities).toHaveBeenNthCalledWith(2, { taskId: 'task-1' })
    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('hides the previous task grant immediately when the task changes in the same scope', async () => {
    const { result, rerender } = renderHook(
      ({ taskId }) => useWorkAgentCapabilities('worktree-1', taskId, 'task-continuation'),
      { initialProps: { taskId: 'task-1' } }
    )
    await waitFor(() => expect(result.current.usable).toHaveLength(4))
    const negotiation = deferred<unknown>()
    mocks.taskContinuationCapabilities.mockReturnValueOnce(negotiation.promise)
    mocks.discovery.mockClear()

    rerender({ taskId: 'task-2' })
    expect(result.current.usable).toEqual([])
    expect(mocks.discovery).not.toHaveBeenCalled()
    expect(mocks.taskContinuationCapabilities).toHaveBeenNthCalledWith(2, { taskId: 'task-2' })
    await act(async () => {
      negotiation.resolve({
        ok: true,
        data: { available: false, reason: 'You cannot continue this task.' }
      })
    })

    expectWorkPlanRequired(result.current)
    expect(result.current.continuationUnavailableReason).toBe('You cannot continue this task.')
    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('ignores a stale first-task grant after the current task is denied', async () => {
    const firstTask = deferred<unknown>()
    const currentTask = deferred<unknown>()
    mocks.taskContinuationCapabilities
      .mockReturnValueOnce(firstTask.promise)
      .mockReturnValueOnce(currentTask.promise)
    const { result, rerender } = renderHook(
      ({ taskId }) => useWorkAgentCapabilities('worktree-1', taskId, 'task-continuation'),
      { initialProps: { taskId: 'task-1' } }
    )

    rerender({ taskId: 'task-2' })
    expect(result.current.usable).toEqual([])
    expect(mocks.taskContinuationCapabilities.mock.calls).toEqual([
      [{ taskId: 'task-1' }],
      [{ taskId: 'task-2' }]
    ])
    await act(async () => {
      currentTask.resolve({
        ok: true,
        data: { available: false, reason: 'This task belongs to another employee.' }
      })
    })
    expectWorkPlanRequired(result.current)

    await act(async () => {
      firstTask.resolve({ ok: true, data: { available: true } })
    })
    expectWorkPlanRequired(result.current)
    expect(result.current.continuationUnavailableReason).toBe(
      'This task belongs to another employee.'
    )
    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('invalidates prior continuation support when the handoff scope changes', async () => {
    const { result, rerender } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.usable).toHaveLength(4))
    const negotiation = deferred<unknown>()
    mocks.taskContinuationCapabilities.mockReturnValueOnce(negotiation.promise)
    mocks.discovery.mockClear()

    mocks.scope += 1
    rerender()
    expect(result.current.usable).toEqual([])
    expect(mocks.discovery).not.toHaveBeenCalled()
    expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(2)
    await act(async () => {
      negotiation.resolve({ ok: true, data: { available: false } })
    })

    expectWorkPlanRequired(result.current)
    expect(mocks.discovery).not.toHaveBeenCalled()
  })

  it('still excludes disabled providers and providers without usage evidence', async () => {
    mocks.settings!.disabledTuiAgents = ['codex']
    mocks.rates.grok = null
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(statuses(result.current)).toMatchObject({
      claude: 'usable',
      codex: 'disabled',
      grok: 'unverified'
    })
    expect(result.current.usable.map(({ id }) => id)).toEqual(['claude', 'gemini'])
    expect(result.current.capabilities.find(({ id }) => id === 'codex')?.models).toEqual([])
    expect(result.current.capabilities.find(({ id }) => id === 'grok')?.models).toEqual([])
  })

  it('requires probed models even when continuation and provider quota are available', async () => {
    mocks.discovery.mockImplementation(async (_runtime, agent: TuiAgent) => ({
      ...discoveredModels(agent),
      catalogOrigin: agent === 'codex' ? 'fallback' : 'probe'
    }))
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(statuses(result.current).codex).toBe('model-unavailable')
    expect(result.current.usable.map(({ id }) => id)).toEqual(['claude', 'grok', 'gemini'])
  })

  it('restores the workspace launch fence despite cached continuation evidence and refresh', async () => {
    mocks.linkedTaskId = 'task-1'
    const { result, rerender } = renderHook(
      ({ mode }: { mode: WorkAgentCapabilityMode }) =>
        useWorkAgentCapabilities('worktree-1', undefined, mode),
      { initialProps: { mode: 'task-continuation' as WorkAgentCapabilityMode } }
    )
    await waitFor(() => expect(result.current.usable).toHaveLength(4))
    mocks.discovery.mockClear()

    rerender({ mode: 'workspace-launch' })
    expectWorkPlanRequired(result.current)
    await act(async () => {
      const refreshed = await result.current.refresh()
      expect(refreshed).toHaveLength(mocks.detected.length)
      expect(refreshed.every((entry) => entry.status === 'work-plan-required')).toBe(true)
    })
    expectWorkPlanRequired(result.current)
    expect(mocks.discovery).not.toHaveBeenCalled()
    expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(1)

    const negotiation = deferred<unknown>()
    mocks.taskContinuationCapabilities.mockReturnValueOnce(negotiation.promise)
    rerender({ mode: 'task-continuation' })
    expect(result.current.usable).toEqual([])
    expect(mocks.taskContinuationCapabilities).toHaveBeenCalledTimes(2)
    await act(async () => {
      negotiation.resolve({ ok: true, data: { available: false } })
    })
    expectWorkPlanRequired(result.current)
  })

  it('requires the remote execution host usage instead of borrowing local provider quota', async () => {
    mocks.target = { kind: 'runtime', environmentId: 'paired-host' }
    const { result, rerender } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', 'task-1', 'task-continuation')
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.usable).toEqual([])
    expect(statuses(result.current)).toMatchObject({
      claude: 'unverified',
      codex: 'unverified',
      grok: 'unverified'
    })
    expect(mocks.refreshUsage).not.toHaveBeenCalled()

    mocks.remoteRates = { ...mocks.rates, codex: null }
    rerender()
    expect(result.current.usable.map(({ id }) => id)).toEqual(['claude', 'grok', 'gemini'])
    expect(statuses(result.current).codex).toBe('unverified')
  })

  it('bounds unresolved model discovery and leaves an honest retryable unavailable state', async () => {
    vi.useFakeTimers()
    mocks.discovery.mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useWorkAgentCapabilities('worktree-1'))
    expect(result.current.loading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.usable).toEqual([])
    expect(
      Object.values(statuses(result.current)).every((status) => status === 'model-unavailable')
    ).toBe(true)
    vi.useRealTimers()
  })
})

describe('host-attested OMP availability', () => {
  const model = {
    id: 'openrouter/x-ai/grok-4.5',
    label: 'Grok',
    openrouterRouting: 'omp-openrouter-routing-v1' as const
  }
  function ompProbe() {
    mocks.detected = ['omp']
    mocks.refreshDetection.mockResolvedValue(mocks.detected)
    mocks.discovery.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [model] })
  }

  it.each(['workspace-launch', 'task-continuation'] as const)(
    'offers only host-attested native OMP models for %s without borrowing another provider receipt',
    async (mode) => {
      ompProbe()
      if (mode === 'task-continuation') {
        mocks.linkedTaskId = 'task'
        mocks.taskContinuationCapabilities.mockResolvedValue({
          ok: true,
          data: { available: true, openrouter_routing: true }
        })
      }
      const { result } = renderHook(() =>
        useWorkAgentCapabilities('worktree-omp', mocks.linkedTaskId, mode)
      )
      await waitFor(() => expect(result.current.usable.map((entry) => entry.id)).toEqual(['omp']))
      expect(result.current.usable[0]!.models[0]).toMatchObject(model)
      if (mode === 'task-continuation') {
        mocks.taskContinuationCapabilities.mockResolvedValue({
          ok: true,
          data: { available: true }
        })
        await act(() => result.current.refresh())
        expect(result.current.usable).toEqual([])
        mocks.taskContinuationCapabilities.mockResolvedValue({
          ok: true,
          data: { available: true, openrouter_routing: true }
        })
      }
      mocks.discovery.mockResolvedValue({
        success: true,
        catalogOrigin: 'probe',
        models: [{ ...model, openrouterRouting: undefined }]
      })
      await act(() => result.current.refresh())
      expect(result.current.usable).toEqual([])
    }
  )

  it('does not borrow attested choices after host/account scope changes', async () => {
    ompProbe()
    const view = renderHook(() => useWorkAgentCapabilities('worktree-omp'))
    await waitFor(() => expect(view.result.current.usable).toHaveLength(1))
    const pending = deferred<ReturnType<typeof discoveredModels>>()
    mocks.discovery.mockReturnValue(pending.promise)
    mocks.scope += 1
    mocks.target = { kind: 'ssh', connectionId: 'other' }
    view.rerender()
    expect(view.result.current.usable).toEqual([])
    await act(async () =>
      pending.resolve({
        success: true,
        catalogOrigin: 'probe',
        models: [{ id: model.id, label: model.label }]
      })
    )
    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(view.result.current.usable).toEqual([])
  })
})

describe('Kimi launcher sign-in gate', () => {
  const launcherKimi = async () => {
    mocks.detected = ['claude', 'kimi']
    const { result } = renderHook(() =>
      useWorkAgentCapabilities('worktree-1', undefined, 'workspace-launch', true)
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    return statuses(result.current).kimi
  }
  it.each([
    [false, 'logged-out'],
    [true, 'usable'],
    [undefined, 'unverified']
  ] as const)('local login %s makes Kimi %s', async (flag, status) => {
    mocks.rates = { ...mocks.rates, kimiAuthConfigured: flag }
    expect(await launcherKimi()).toBe(status)
  })
  it('reads the flag from the remote execution host, not the desktop', async () => {
    mocks.target = { kind: 'runtime', environmentId: 'paired-host' }
    mocks.rates = { ...mocks.rates, kimiAuthConfigured: true }
    expect(await launcherKimi()).toBe('unverified')
    cleanup()
    mocks.remoteRates = { ...mocks.rates, kimiAuthConfigured: false }
    expect(await launcherKimi()).toBe('logged-out')
    cleanup()
    mocks.remoteRates = { ...mocks.rates, kimiAuthConfigured: true }
    expect(await launcherKimi()).toBe('usable')
  })
})
