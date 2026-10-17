// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'

const ENV_A = 'env-a'
const LOCAL_WT = 'repo-local::/local'
const SSH_WT = 'repo-ssh::/remote'
vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: () => 'env-a\u0001runtime-a\u00010\u0001101'
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerModule>()),
  getExplicitRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (
    _state: unknown,
    snapshot: RuntimeMobileSessionTabsResult
  ) => snapshot
}))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionModule>()),
  createWebRuntimeSessionTerminal: vi.fn()
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
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const initialState = useAppStore.getInitialState()
type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
const subscriptions: {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}[] = []
const runtimeCall = vi.fn(async (_args: { method: string }) => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] as RuntimeMobileSessionTabsResult[] },
  _meta: { runtimeId: 'runtime-test' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

function terminalFrame(worktree: string, hostTabId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${hostTabId}::leaf`,
        parentTabId: hostTabId,
        leafId: '11111111-1111-4111-8111-111111111111',
        title: hostTabId,
        isActive: true,
        status: 'ready',
        terminal: `${hostTabId}-handle`
      }
    ]
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Publishes on the Nth subscribeAll stream for env-a (0 = initial, 1 = after one resume). */
async function publishInventory(occurrence: number, result: unknown): Promise<void> {
  const stream = subscriptions.filter(
    ({ request }) => request.method === 'session.tabs.subscribeAll'
  )[occurrence]
  if (!stream) {
    throw new Error(`Missing subscribeAll stream ${occurrence}`)
  }
  await act(async () => {
    stream.callbacks.onResponse({ id: 'stream', ok: true, result, _meta: { runtimeId: 'rt' } })
    await settle()
  })
}

async function parkAndResume(): Promise<void> {
  act(() => {
    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
  })
  await act(settle)
}

function rows(worktree: string): [string, boolean][] {
  return (useAppStore.getState().tabsByWorktree[worktree] ?? []).map((tab) => [
    tab.id,
    tab.mirrorAbsenceUnverified === true
  ])
}

describe('visibility recovery uses scoped absence evidence (step 6, C4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: 101 }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    useAppStore.setState(
      {
        ...initialState,
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
    resetStaleDocumentVisibilityForTesting()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  async function mirrorBothWorkspaces(): Promise<{ unmount: () => void }> {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publishInventory(0, {
      type: 'snapshots',
      snapshots: [terminalFrame(LOCAL_WT, 'local-tab'), terminalFrame(SSH_WT, 'ssh-tab')],
      authoritative: true
    })
    expect(rows(LOCAL_WT)).toEqual([[toWebTerminalSurfaceTabId('local-tab'), false]])
    expect(rows(SSH_WT)).toEqual([[toWebTerminalSurfaceTabId('ssh-tab'), false]])
    await parkAndResume()
    return hook
  }

  it('removes nothing when the resume inventory carries no evidence (older owner)', async () => {
    const hook = await mirrorBothWorkspaces()

    await publishInventory(1, { type: 'snapshots', snapshots: [] })

    expect(rows(LOCAL_WT)).toEqual([[toWebTerminalSurfaceTabId('local-tab'), true]])
    expect(rows(SSH_WT)).toEqual([[toWebTerminalSurfaceTabId('ssh-tab'), true]])
    hook.unmount()
  })

  it("removes exactly the covered workspace's rows and keeps the unasked host's", async () => {
    const hook = await mirrorBothWorkspaces()

    await publishInventory(1, {
      type: 'snapshots',
      snapshots: [],
      coverage: { unverifiedRepoIds: ['repo-ssh'], unverifiedWorkspaces: [] }
    })

    expect(rows(LOCAL_WT)).toEqual([])
    expect(rows(SSH_WT)).toEqual([[toWebTerminalSurfaceTabId('ssh-tab'), true]])
    hook.unmount()
  })

  it('removes every omitted row when the resume inventory is authoritative (control)', async () => {
    const hook = await mirrorBothWorkspaces()

    await publishInventory(1, { type: 'snapshots', snapshots: [], authoritative: true })

    expect(rows(LOCAL_WT)).toEqual([])
    expect(rows(SSH_WT)).toEqual([])
    hook.unmount()
  })
})
