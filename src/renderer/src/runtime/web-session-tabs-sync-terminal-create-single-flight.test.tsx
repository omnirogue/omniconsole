// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'
const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn()
}))
vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: () => 'env-a\u0001runtime-a\u00010\u0001101'
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
}))
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (
    _state: unknown,
    snapshot: RuntimeMobileSessionTabsResult
  ) => snapshot
}))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionModule>()),
  createWebRuntimeSessionTerminal: mocks.createTerminal
}))
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import {
  clearWebSessionTabsTrackingForEnvironment,
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import {
  beginWebRuntimeAutomaticTerminalCreate,
  resetWebRuntimeAutomaticTerminalCreatesForTests
} from './web-runtime-automatic-terminal-create'
const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const initialState = useAppStore.getInitialState()
type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
const subscriptions: {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}[] = []
const runtimeCall = vi.fn(async (_args: { method: string }) => ({
  id: 'list-all',
  ok: true as const,
  result: {
    snapshots: [] as RuntimeMobileSessionTabsResult[],
    authoritative: undefined as true | undefined
  },
  _meta: { runtimeId: 'runtime-test' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeEmptySnapshot(snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function findSubscription(method: string, selector: string) {
  const subscription = subscriptions.find(
    (s) => s.request.method === method && s.request.selector === selector
  )
  if (!subscription) {
    throw new Error('Missing subscription')
  }
  return subscription
}
async function publish(subscription: ReturnType<typeof findSubscription>, result: unknown) {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'stream',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-test' }
    })
    await settle()
  })
}
describe('automatic remote terminal creation', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockReset().mockResolvedValue({
      id: 'list-all',
      ok: true,
      result: { snapshots: [], authoritative: undefined },
      _meta: { runtimeId: 'runtime-test' }
    })
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: 101 }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map([
          [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
      },
      true
    )
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    clearHostLiveTerminalProbesForTests()
  })
  it.each(['switch', 'reconnect', 'renderer reload'] as const)(
    'keeps one initial create while a %s rebuilds the active subscription',
    async (rebuild) => {
      const pendingCreate = createDeferred<unknown>()
      mocks.createTerminal.mockReturnValue(pendingCreate.promise)
      let hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription('session.tabs.subscribe', ENV_A), {
        type: 'snapshot',
        ...makeEmptySnapshot()
      })
      expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

      if (rebuild === 'switch') {
        act(() => useAppStore.setState({ activeWorktreeId: null }))
        await act(settle)
        act(() => useAppStore.setState({ activeWorktreeId: WORKTREE }))
      } else if (rebuild === 'reconnect') {
        act(() =>
          useAppStore.setState({
            runtimeStatusByEnvironmentId: new Map([
              [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 2 }]
            ]) as AppState['runtimeStatusByEnvironmentId']
          })
        )
      } else {
        hook.unmount()
        resetWebRuntimeAutomaticTerminalCreatesForTests({ preserveStorage: true })
        hook = renderHook(() => useWebSessionTabsSync())
      }
      await act(settle)
      const activeSubscriptions = subscriptions.filter(
        (entry) => entry.request.method === 'session.tabs.subscribe'
      )
      expect(activeSubscriptions).toHaveLength(2)
      await publish(activeSubscriptions[1]!, {
        type: 'snapshot',
        ...makeEmptySnapshot(2)
      })
      expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
      pendingCreate.resolve(undefined)
      await act(settle)
      hook.unmount()
    }
  )

  it('shares one create between a wake and the following empty initial snapshot', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'web-terminal-restored',
            title: 'Restored shell',
            createdAt: 1,
            sortOrder: 0,
            ptyId: null,
            worktreeId: WORKTREE,
            customTitle: null,
            color: null
          }
        ]
      }
    })
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const activeSubscription = findSubscription('session.tabs.subscribe', ENV_A)
    await publish(activeSubscription, { type: 'snapshot', ...makeEmptySnapshot() })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal.mock.calls[0]?.[0]).toMatchObject({ selectWorktree: false })
    clearWebSessionTabsTrackingForEnvironment('unrelated-host')
    await publish(activeSubscription, { type: 'snapshot', ...makeEmptySnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    pendingCreate.resolve({ status: 'created' })
    await act(settle)
    hook.unmount()
  })

  it('shares one create between explicit workspace wake and incoming snapshots', async () => {
    useAppStore.setState({
      getKnownWorktreeById: vi.fn(
        () =>
          ({
            id: WORKTREE
          }) as NonNullable<ReturnType<AppState['getKnownWorktreeById']>>
      ),
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 0,
        activeRenderableTabId: null
      }))
    })
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)
    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A), {
      type: 'snapshot',
      ...makeEmptySnapshot()
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    pendingCreate.resolve({ status: 'created' })
    await act(settle)
    hook.unmount()
  })

  it('keeps a published pending host terminal through a complete mirror remount', async () => {
    const pendingSnapshot = {
      ...makeEmptySnapshot(),
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-pending::leaf-1',
          parentTabId: 'host-pending',
          leafId: 'leaf-1',
          title: 'Starting shell',
          status: 'pending' as const,
          isActive: true
        }
      ]
    }
    const first = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A), {
      type: 'snapshot',
      ...pendingSnapshot
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    first.unmount()
    subscriptions.length = 0
    const remounted = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A), {
      type: 'snapshot',
      ...pendingSnapshot
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    remounted.unmount()
  })

  it('settles the automatic hold on its exact ready host tab, preserving pending rows', async () => {
    const owner = { environmentId: ENV_A, pairingRevision: 101 }
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, WORKTREE)!
    operation.onSessionCreated('web-terminal-host-created%3A%3Aleaf-1')
    operation.finish({ status: 'created' })
    resetWebRuntimeAutomaticTerminalCreatesForTests({ preserveStorage: true })
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const active = findSubscription('session.tabs.subscribe', ENV_A)
    const pending = {
      ...makeEmptySnapshot(),
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-created::leaf-1',
          parentTabId: 'host-created',
          leafId: 'leaf-1',
          title: 'Starting shell',
          status: 'pending' as const,
          isActive: true
        }
      ]
    }
    await publish(active, { type: 'snapshot', ...pending })
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, WORKTREE)).toBeNull()
    await publish(active, {
      type: 'snapshot',
      ...pending,
      snapshotVersion: 2,
      tabs: [{ ...pending.tabs[0]!, status: 'ready', terminal: 'term-created' }]
    })
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, WORKTREE)).not.toBeNull()
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  it.each([
    { label: 'definitive', creationUnverifiable: undefined, expectedCreates: 2 },
    { label: 'unverifiable', creationUnverifiable: true, expectedCreates: 1 }
  ])(
    'handles a $label create failure without replaying lost receipts',
    async ({ creationUnverifiable, expectedCreates }) => {
      mocks.createTerminal.mockResolvedValue({
        status: 'failed',
        message: 'Creation failed',
        ...(creationUnverifiable ? { creationUnverifiable } : {})
      })
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      const activeSubscription = findSubscription('session.tabs.subscribe', ENV_A)
      await publish(activeSubscription, { type: 'snapshot', ...makeEmptySnapshot() })
      await publish(activeSubscription, { type: 'snapshot', ...makeEmptySnapshot(2) })
      expect(mocks.createTerminal).toHaveBeenCalledTimes(expectedCreates)
      expect(mocks.createTerminal.mock.calls[0]?.[0]?.clientMutationId).toEqual(expect.any(String))
      hook.unmount()
    }
  )
})
