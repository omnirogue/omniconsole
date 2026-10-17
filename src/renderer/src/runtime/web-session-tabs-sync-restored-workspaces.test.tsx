// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'
const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn()
}))
vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: () => 'env-a\u0001runtime-a\u00010\u0001101'
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
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
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
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

function makeBrowserSnapshot(idSuffix = ''): RuntimeMobileSessionTabsResult {
  return {
    ...makeEmptySnapshot(),
    activeTabId: `host-browser-tab${idSuffix}`,
    activeTabType: 'browser',
    tabs: [
      {
        type: 'browser',
        id: `host-browser-tab${idSuffix}`,
        title: 'Remote browser',
        browserWorkspaceId: `host-browser-workspace${idSuffix}`,
        browserPageId: `host-browser-page${idSuffix}`,
        url: 'https://example.com/',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: true
      }
    ]
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
describe('initial inventory reconciles restored session mirrors', () => {
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
        // Why: a restored row without its own PTY evidence belongs to the saved catalog owner.
        repos: [
          { id: 'repo-a', executionHostId: `runtime:${ENV_A}` }
        ] as unknown as AppState['repos'],
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
  function seedRestoredTerminalMirror(): string {
    const tabId = toWebTerminalSurfaceTabId('restored-reviewer')
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: tabId,
            title: 'Old reviewer',
            launchAgent: 'codex',
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
    return tabId
  }

  /** Scoped evidence: the owner's census answered for every host (nothing unverified). */
  const COMPLETE_COVERAGE = { unverifiedRepoIds: [], unverifiedWorkspaces: [] }

  function answerInitialInventory(
    snapshots: RuntimeMobileSessionTabsResult[],
    evidence: { coverage?: { unverifiedRepoIds: string[]; unverifiedWorkspaces: string[] } } = {
      coverage: COMPLETE_COVERAGE
    }
  ): void {
    runtimeCall.mockResolvedValue({
      id: 'list-all',
      ok: true,
      result: { snapshots, authoritative: undefined, ...evidence },
      _meta: { runtimeId: 'runtime-test' }
    })
  }

  it('removes a restored peer workspace a scoped inventory confirms absent', async () => {
    seedRestoredTerminalMirror()
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  // Step 6 (C4): an older owner's nonempty inventory without evidence no longer proves absence.
  it('keeps and flags a restored workspace an unlabeled (legacy) inventory omits', async () => {
    const tabId = seedRestoredTerminalMirror()
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }], {})
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const rows = useAppStore.getState().tabsByWorktree[WORKTREE] ?? []
    expect(rows.map((tab) => [tab.id, tab.mirrorAbsenceUnverified])).toEqual([[tabId, true]])
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  it("keeps and flags a restored workspace inside the inventory's unverified census scope", async () => {
    const tabId = seedRestoredTerminalMirror()
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }], {
      coverage: { unverifiedRepoIds: ['repo-a'], unverifiedWorkspaces: [] }
    })
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const rows = useAppStore.getState().tabsByWorktree[WORKTREE] ?? []
    expect(rows.map((tab) => [tab.id, tab.mirrorAbsenceUnverified])).toEqual([[tabId, true]])
    hook.unmount()
  })

  it('keeps restored mirrors when an initial empty inventory has no authority', async () => {
    const tabId = seedRestoredTerminalMirror()
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    hook.unmount()
  })

  it('removes restored mirrors when an initial empty inventory is authoritative', async () => {
    seedRestoredTerminalMirror()
    runtimeCall.mockResolvedValue({
      id: 'empty-authoritative',
      ok: true,
      result: { snapshots: [], authoritative: true },
      _meta: { runtimeId: 'runtime-test' }
    })
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
    hook.unmount()
  })

  it('keeps a local terminal beside restored mirrors during initial reconciliation', async () => {
    const tabId = seedRestoredTerminalMirror()
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [WORKTREE]: [
          ...state.tabsByWorktree[WORKTREE]!,
          {
            id: 'local-shell',
            title: 'Local',
            createdAt: 1,
            sortOrder: 1,
            ptyId: null,
            worktreeId: WORKTREE,
            customTitle: null,
            color: null
          }
        ]
      }
    }))
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    // Why: owner-scoped removal retracts only the omitting environment's stale mirror now; the
    // local terminal beside it is never touched.
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      'local-shell'
    ])
    expect(tabId).not.toBe('local-shell')
    hook.unmount()
  })

  it('keeps bindings belonging to another peer even when workspace ownership metadata is stale', async () => {
    const tabId = seedRestoredTerminalMirror()
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            ...state.tabsByWorktree[WORKTREE]![0]!,
            ptyId: toRemoteRuntimePtyId('term-other', 'env-b')
          }
        ]
      }
    }))
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    hook.unmount()
  })

  it("retracts only this environment's restored rows from a workspace another owner shares", async () => {
    const tabId = seedRestoredTerminalMirror()
    const otherTabId = toWebTerminalSurfaceTabId('other-owner-reviewer')
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            ...state.tabsByWorktree[WORKTREE]![0]!,
            ptyId: toRemoteRuntimePtyId('term-a', ENV_A)
          },
          {
            ...state.tabsByWorktree[WORKTREE]![0]!,
            id: otherTabId,
            ptyId: toRemoteRuntimePtyId('term-b', 'env-b')
          }
        ]
      }
    }))
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      otherTabId
    ])
    expect(tabId).not.toBe(otherTabId)
    hook.unmount()
  })

  /** A conversation copy restored after a restart: client-minted id, no PTY, a quit record. */
  function seedRestoredConversationCopy(): string {
    const tabId = 'restored-conversation-copy'
    const paneKey = `${tabId}:11111111-1111-4111-8111-111111111111`
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: tabId,
            title: 'Old conversation',
            launchAgent: 'claude',
            pendingActivationSpawn: true,
            createdAt: 1,
            sortOrder: 0,
            ptyId: null,
            worktreeId: WORKTREE,
            customTitle: null,
            color: null
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId,
          worktreeId: WORKTREE,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'ended-on-owner' },
          prompt: '',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'quit',
          resumeOnFirstReveal: true
        }
      }
    })
    return tabId
  }

  // A4: the copy is the catalog owner's by catalog, so its first complete inventory settles it.
  it('cleans a restored conversation copy on the first inventory that lists its workspace', async () => {
    seedRestoredConversationCopy()
    answerInitialInventory([makeEmptySnapshot()])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('cleans a restored conversation copy whose workspace a scoped inventory confirms absent', async () => {
    seedRestoredConversationCopy()
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }])
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    hook.unmount()
  })

  it('keeps and flags a restored conversation copy an unverified inventory omits', async () => {
    const tabId = seedRestoredConversationCopy()
    answerInitialInventory([{ ...makeEmptySnapshot(), worktree: 'still-published-workspace' }], {})
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const rows = useAppStore.getState().tabsByWorktree[WORKTREE] ?? []
    expect(rows.map((tab) => [tab.id, tab.mirrorAbsenceUnverified])).toEqual([[tabId, true]])
    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(1)
    hook.unmount()
  })

  it('keeps a newer host frame when a delayed initial inventory omits its workspace', async () => {
    seedRestoredTerminalMirror()
    const delayed = createDeferred<Awaited<ReturnType<typeof runtimeCall>>>()
    runtimeCall.mockImplementationOnce(() => delayed.promise)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot()]
    })
    await act(async () => {
      delayed.resolve({
        id: 'delayed-inventory',
        ok: true,
        result: {
          snapshots: [{ ...makeEmptySnapshot(), worktree: 'another-workspace' }],
          authoritative: undefined
        },
        _meta: { runtimeId: 'runtime-test' }
      })
      await settle()
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    hook.unmount()
  })
})
