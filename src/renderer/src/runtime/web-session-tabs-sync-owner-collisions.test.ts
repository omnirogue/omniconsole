import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeAgentHookCompletionForNotification
}))

import { useAppStore } from '@/store'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyWebSessionTabsStorePatch,
  countWebSessionTabsInventorySnapshots,
  decideWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import { hasHostSessionMirrorHydrated } from './host-session-mirror-hydration'
import { resolveWebTerminalSurfaceTabIdForHost } from './web-session-mirror-owner'
import { settleWebRuntimeTerminalPlacement } from './web-runtime-terminal-placement-settlement'
import {
  LEAF_ID,
  NOW,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const W1 = 'repo::/one'
const W2 = 'repo::/two'
const initialState = useAppStore.getInitialState()

function frame(worktree: string, hostTabIds: readonly string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: hostTabIds.map((hostTabId) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: `Session ${hostTabId}`,
      launchAgent: 'claude' as const,
      isActive: false,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`,
      agentStatus: {
        state: 'working' as const,
        prompt: `prompt from ${worktree}`,
        updatedAt: NOW,
        stateStartedAt: NOW,
        agentType: 'claude' as const,
        paneKey: makePaneKey(hostTabId, LEAF_ID),
        tabId: hostTabId,
        worktreeId: worktree,
        stateHistory: []
      }
    }))
  }
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

describe('owner-qualified ids for a colliding second owner', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    mocks.observeAgentHookCompletionForNotification.mockReset()
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSyncTestState()
  })

  it('qualifies an identical host tab id published by another owner in another workspace', () => {
    const legacy = toWebTerminalSurfaceTabId('t')
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't')

    let state = send(makeState(), ENV_A, frame(W1, ['t']))
    const aLayout = state.terminalLayoutsByTabId[legacy]
    state = send(state, ENV_B, frame(W2, ['t']))

    expect(state.tabsByWorktree[W1]?.map((tab) => tab.id)).toEqual([legacy])
    expect(state.tabsByWorktree[W2]?.map((tab) => tab.id)).toEqual([qualified])
    // Why: layouts, bindings and status are keyed by client id across workspaces.
    expect(state.terminalLayoutsByTabId[legacy]).toBe(aLayout)
    expect(state.ptyIdsByTabId[legacy]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_A)])
    expect(state.ptyIdsByTabId[qualified]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_B)])
    expect(state.agentStatusByPaneKey[makePaneKey(legacy, LEAF_ID)]?.worktreeId).toBe(W1)
    expect(state.agentStatusByPaneKey[makePaneKey(qualified, LEAF_ID)]?.worktreeId).toBe(W2)
  })

  it("notifies on the colliding owner's own owner-qualified pane", () => {
    const apply = (environmentId: string, snapshot: RuntimeMobileSessionTabsResult): void => {
      const decision = decideWebSessionTabsSnapshot(snapshot, environmentId)
      applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW),
        { frames: [{ environmentId, worktreeId: snapshot.worktree, decision }] },
        snapshot
      )
    }
    apply(ENV_A, frame(W1, ['t']))
    apply(ENV_B, frame(W1, ['t']))

    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenCalledTimes(2)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: makePaneKey(toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't'), LEAF_ID),
        worktreeId: W1
      })
    )
  })

  it('gives create, split-focus and launch helpers the id the receiver assigns', async () => {
    const legacy = toWebTerminalSurfaceTabId('t')
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't')
    const state = send(makeState(), ENV_A, frame(W1, ['t']))

    // Before B's frame lands, the helpers predict the id its frame will mint.
    expect(resolveWebTerminalSurfaceTabIdForHost(state, ENV_B, W1, 't')).toBe(qualified)
    expect(resolveWebTerminalSurfaceTabIdForHost(state, ENV_A, W1, 't')).toBe(legacy)
    expect(resolveWebTerminalSurfaceTabIdForHost(state, ENV_B, W1, 'fresh')).toBe(
      toWebTerminalSurfaceTabId('fresh')
    )
    const landed = send(state, ENV_B, frame(W1, ['t']))
    expect(landed.tabsByWorktree[W1]?.map((tab) => tab.id)).toContain(qualified)
    expect(resolveWebTerminalSurfaceTabIdForHost(landed, ENV_B, W1, 't')).toBe(qualified)

    // A create flow's placement settlement must find and move B's qualified tab, not A's.
    const groups = [
      { id: 'group-1', worktreeId: W1, activeTabId: legacy, tabOrder: [legacy, qualified] },
      { id: 'group-2', worktreeId: W1, activeTabId: null, tabOrder: [] }
    ]
    useAppStore.setState({
      ...landed,
      groupsByWorktree: { [W1]: groups },
      unifiedTabsByWorktree: {
        [W1]: (landed.unifiedTabsByWorktree[W1] ?? []).map((tab) => ({
          ...tab,
          groupId: 'group-1'
        }))
      }
    } as Partial<ReturnType<typeof useAppStore.getState>>)
    await settleWebRuntimeTerminalPlacement(ENV_B, W1, 't', { groupId: 'group-2', activate: false })

    const unified = useAppStore.getState().unifiedTabsByWorktree[W1] ?? []
    expect(unified.find((tab) => tab.id === qualified)?.groupId).toBe('group-2')
    expect(unified.find((tab) => tab.id === legacy)?.groupId).toBe('group-1')
  })

  it("resolves each frame's own ids when one patch carries two owners of a workspace", () => {
    const snapshotA = frame(W1, ['t'])
    const snapshotB = frame(W1, ['t'])
    const decisionA = decideWebSessionTabsSnapshot(snapshotA, ENV_A)
    const decisionB = decideWebSessionTabsSnapshot(snapshotB, ENV_B)
    applyWebSessionTabsStorePatch(
      (state) => {
        const afterA = { ...state, ...applyWebSessionTabsSnapshots(state, [snapshotA], ENV_A, NOW) }
        return { ...afterA, ...applyWebSessionTabsSnapshots(afterA, [snapshotB], ENV_B, NOW) }
      },
      {
        frames: [
          { environmentId: ENV_A, worktreeId: W1, decision: decisionA },
          { environmentId: ENV_B, worktreeId: W1, decision: decisionB }
        ]
      },
      [snapshotA, snapshotB]
    )

    expect(
      mocks.observeAgentHookCompletionForNotification.mock.calls.map(([status]) => status.paneKey)
    ).toEqual([
      makePaneKey(toWebTerminalSurfaceTabId('t'), LEAF_ID),
      makePaneKey(toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't'), LEAF_ID)
    ])
  })

  it('does not let an ignored echo inside a full listing hold the listing back from loaded', () => {
    useAppStore.setState({
      repos: [{ id: 'peer-repo', executionHostId: `runtime:${ENV_B}` }] as never
    })
    const owned = frame(W1, ['t'])
    const echo = frame('peer-repo::/echo', ['e'])
    const decisions = [owned, echo].map((snapshot) => decideWebSessionTabsSnapshot(snapshot, ENV_A))
    expect(decisions.map((decision) => decision.apply)).toEqual([true, false])

    applyWebSessionTabsStorePatch(
      (state) => applyWebSessionTabsSnapshots(state, [owned], ENV_A, NOW),
      {
        frames: [owned, echo].map((snapshot, index) => ({
          environmentId: ENV_A,
          worktreeId: snapshot.worktree,
          decision: decisions[index]!
        })),
        fullInventory: {
          environmentId: ENV_A,
          publishedSnapshotCount: countWebSessionTabsInventorySnapshots(ENV_A, [owned, echo])
        }
      },
      [owned]
    )()

    // Why: environment-wide "loaded" also covers workspaces the listing never mentioned.
    expect(hasHostSessionMirrorHydrated(ENV_A, 'repo::/never-listed')).toBe(true)
  })
})
