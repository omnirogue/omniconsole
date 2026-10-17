import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  decideWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  LEAF_ID,
  NOW,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const OLD = 'env-old'
const NEW = 'env-new'
const OTHER = 'env-other'
const initialState = useAppStore.getInitialState()

function frame(hostTabIds: readonly string[], snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: hostTabIds.map((hostTabId) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: `Session ${hostTabId}`,
      launchAgent: 'codex' as const,
      isActive: false,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`
    }))
  }
}

function environment(
  id: string,
  runtimeId: string | null,
  createdAt: number
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: null,
    runtimeId,
    endpoints: [{ id: 'endpoint', kind: 'websocket', label: id, endpoint: `ws://${id}` }],
    preferredEndpointId: 'endpoint'
  }
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

function rows(state: { tabsByWorktree: WebSessionTabsSyncState['tabsByWorktree'] }): string[] {
  return (state.tabsByWorktree[WT] ?? []).map((tab) => `${tab.id}=${tab.ptyId}`).sort()
}

describe('mirrors from a retired environment id', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSyncTestState()
  })

  it.each([
    [
      'its pairing record',
      { runtimeEnvironments: [environment(OLD, 'host-1', 1), environment(NEW, 'host-1', 2)] }
    ],
    [
      'its live status',
      {
        runtimeEnvironments: [environment(OLD, null, 1), environment(NEW, null, 2)],
        runtimeStatusByEnvironmentId: new Map([
          [OLD, { status: { runtimeId: 'live-1' } }],
          [NEW, { status: { runtimeId: 'live-1' } }]
        ])
      }
    ]
  ])('lets a re-paired host proven the same by %s take over without duplicates', (_, catalog) => {
    const before = send(makeState(), OLD, frame(['t', 'u']))
    const repaired = {
      ...before,
      ...catalog,
      runtimeEnvironmentCatalogHydrated: true
    } as WebSessionTabsSyncState

    const after = send(repaired, NEW, frame(['t', 'u']))

    expect(rows(after)).toEqual([
      `${toWebTerminalSurfaceTabId('t')}=${toRemoteRuntimePtyId('t-handle', NEW)}`,
      `${toWebTerminalSurfaceTabId('u')}=${toRemoteRuntimePtyId('u-handle', NEW)}`
    ])
    // Why: the superseded pairing would only republish duplicates of the same host's rows.
    expect(
      decideWebSessionTabsSnapshot(frame(['t', 'u'], 2), OLD, undefined, undefined, after).apply
    ).toBe(false)
  })

  it('keeps an unproven older environment and its rows (no re-attribution on a guess)', () => {
    const before = send(makeState(), OLD, frame(['t']))
    const unproven = {
      ...before,
      runtimeEnvironments: [environment(OLD, 'host-1', 1), environment(NEW, 'host-2', 2)],
      runtimeEnvironmentCatalogHydrated: true
    } as WebSessionTabsSyncState

    const after = send(unproven, NEW, frame(['t']))

    expect(rows(after)).toHaveLength(2)
    expect(rows(after)).toContain(
      `${toWebTerminalSurfaceTabId('t')}=${toRemoteRuntimePtyId('t-handle', OLD)}`
    )
  })

  function seedStoreMirrors(): void {
    useAppStore
      .getState()
      .setRuntimeEnvironments([environment(OLD, null, 1), environment(OTHER, null, 2)])
    for (const [environmentId, hostTabIds] of [
      [OLD, ['o1', 'o2']],
      [OTHER, ['x']]
    ] as const) {
      const snapshot = frame(hostTabIds)
      const decision = decideWebSessionTabsSnapshot(snapshot, environmentId)
      applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW),
        { frames: [{ environmentId, worktreeId: WT, decision }] }
      )
    }
    expect(rows(useAppStore.getState())).toHaveLength(3)
  }

  it("retracts a removed environment's rows in the same turn it leaves the saved list", () => {
    seedStoreMirrors()
    const otherGeneration = getWebSessionTabsTrackingGeneration(OTHER)

    useAppStore.getState().setRuntimeEnvironments([environment(OTHER, null, 2)])

    // Why synchronous: no later task may bump tracking after a restarted subscription records it.
    expect(rows(useAppStore.getState())).toEqual([
      `${toWebTerminalSurfaceTabId('x')}=${toRemoteRuntimePtyId('x-handle', OTHER)}`
    ])
    expect(getWebSessionTabsTrackingGeneration(OTHER)).toBe(otherGeneration)
  })

  it('leaves a same-id re-pair alone: no retraction and no tracking-generation bump', async () => {
    seedStoreMirrors()
    const oldGeneration = getWebSessionTabsTrackingGeneration(OLD)

    useAppStore
      .getState()
      .setRuntimeEnvironments([
        { ...environment(OLD, null, 1), pairingRevision: 7 },
        environment(OTHER, null, 2)
      ])
    // A restarted subscription records its generation now; nothing may move it afterwards.
    const recordedGeneration = getWebSessionTabsTrackingGeneration(OLD)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(recordedGeneration).toBe(oldGeneration)
    expect(getWebSessionTabsTrackingGeneration(OLD)).toBe(recordedGeneration)
    expect(rows(useAppStore.getState())).toHaveLength(3)
  })

  it('never supersedes a connected pairing with an unreachable newer one', () => {
    const before = send(makeState(), OLD, frame(['t']))
    const catalog = {
      ...before,
      runtimeEnvironments: [environment(OLD, 'host-1', 1), environment(NEW, 'host-1', 2)],
      runtimeEnvironmentCatalogHydrated: true,
      runtimeStatusByEnvironmentId: new Map([
        [OLD, { status: { runtimeId: 'live-1' } }],
        [NEW, { status: null }]
      ])
    } as unknown as WebSessionTabsSyncState

    expect(
      decideWebSessionTabsSnapshot(frame(['t'], 2), OLD, undefined, undefined, catalog).apply
    ).toBe(true)
    expect(
      decideWebSessionTabsSnapshot(frame(['t'], 1), NEW, undefined, undefined, catalog).apply
    ).toBe(false)
  })

  it('replays a new pairing frame parked while the catalog still credited the old one', async () => {
    useAppStore.setState({
      repos: [{ id: 'repo', executionHostId: `runtime:${OLD}` }] as never,
      runtimeEnvironments: [environment(OLD, null, 1), environment(NEW, null, 2)],
      runtimeEnvironmentCatalogHydrated: true
    })
    const snapshot = frame(['t'])
    const decision = decideWebSessionTabsSnapshot(snapshot, NEW)
    expect(decision.apply).toBe(false)
    expect(rows(useAppStore.getState())).toEqual([])

    // The pairing proof lands: both entries now report the same live runtime.
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [OLD, { status: { runtimeId: 'live-1' } }],
        [NEW, { status: { runtimeId: 'live-1' } }]
      ]) as never
    })

    await vi.waitFor(() =>
      expect(rows(useAppStore.getState())).toEqual([
        `${toWebTerminalSurfaceTabId('t')}=${toRemoteRuntimePtyId('t-handle', NEW)}`
      ])
    )
  })

  it('lets any current publisher retract rows of an environment removed before restart', () => {
    const persisted = send(makeState(), OLD, frame(['o1']))
    resetWebSessionTabsSyncTestState()
    const restarted = {
      ...persisted,
      runtimeEnvironments: [environment(OTHER, null, 2)],
      runtimeEnvironmentCatalogHydrated: true
    } as WebSessionTabsSyncState

    const after = send(restarted, OTHER, frame(['x']))

    expect(rows(after)).toEqual([
      `${toWebTerminalSurfaceTabId('x')}=${toRemoteRuntimePtyId('x-handle', OTHER)}`
    ])
  })
})
