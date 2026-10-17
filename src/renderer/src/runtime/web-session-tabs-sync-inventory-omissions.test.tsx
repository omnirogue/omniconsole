// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
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
describe('the subscribeAll inventory reconciles omitted workspaces when listAll fails (A4)', () => {
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
  const COMPLETE_COVERAGE = { unverifiedRepoIds: [], unverifiedWorkspaces: [] }
  const MIRROR_TAB = toWebTerminalSurfaceTabId('closed-on-owner')
  const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
  const RECORD_ONLY_WORKTREE = 'repo-a::worktree-removed-on-owner'

  function sleepingRecord(tabId: string, worktreeId: string): SleepingAgentSessionRecord {
    return {
      paneKey: makePaneKey(tabId, LEAF),
      tabId,
      worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: `session-${tabId}` },
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      connectionId: null,
      origin: 'live'
    }
  }

  /** A restored mirror row with its record, and a workspace known here only by a record. */
  function seedRestoredMirrors(): void {
    const records = [
      sleepingRecord(MIRROR_TAB, WORKTREE),
      sleepingRecord(toWebTerminalSurfaceTabId('record-only'), RECORD_ONLY_WORKTREE)
    ]
    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: MIRROR_TAB,
            title: 'Old reviewer',
            launchAgent: 'codex',
            createdAt: 1,
            sortOrder: 0,
            ptyId: toRemoteRuntimePtyId('term-closed', ENV_A),
            worktreeId: WORKTREE,
            customTitle: null,
            color: null
          }
        ]
      },
      sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
    })
  }

  function failInitialListAll(): void {
    // Why: live on 6 Oct the reconnect's listAll failed (call-failed) and only the stream answered.
    runtimeCall.mockResolvedValue({
      id: 'list-all',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'not ready' },
      _meta: { runtimeId: 'runtime-test' }
    } as never)
  }

  async function publishInventory(evidence: Record<string, unknown>): Promise<void> {
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [{ ...makeEmptySnapshot(), worktree: 'repo-a::still-published' }],
      ...evidence
    })
  }

  it('removes the omitted mirror workspace and its records on scoped evidence', async () => {
    seedRestoredMirrors()
    failInitialListAll()
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    // Before the fix nothing reconciled omitted workspaces on this connection.
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toHaveLength(1)

    await publishInventory({ coverage: COMPLETE_COVERAGE })

    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({})
    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('keeps and flags an omitted workspace when the inventory carries no evidence', async () => {
    seedRestoredMirrors()
    failInitialListAll()
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publishInventory({})

    const state = useAppStore.getState()
    expect(
      (state.tabsByWorktree[WORKTREE] ?? []).map((tab) => [tab.id, tab.mirrorAbsenceUnverified])
    ).toEqual([[MIRROR_TAB, true]])
    expect(Object.keys(state.sleepingAgentSessionsByPaneKey)).toHaveLength(2)
    hook.unmount()
  })

  it('keeps a workspace inside the unverified census scope', async () => {
    seedRestoredMirrors()
    failInitialListAll()
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publishInventory({
      coverage: { unverifiedRepoIds: ['repo-a'], unverifiedWorkspaces: [] }
    })

    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toHaveLength(1)
    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(2)
    hook.unmount()
  })
})
