import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { workspaceSessionStateSchema } from '../../../shared/workspace-session-schema'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { withoutPendingConversationTabs } from './workspace-session-pending-conversation-tabs'

const WT = 'wt-1'
const LIVE = 'terminal-live'
const PENDING = 'terminal-pending'
const GROUP = 'group-main'

function terminalTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: WT,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(id === PENDING ? { conversationLaunchPending: true } : {})
  }
}

function unifiedTab(id: string, groupId = GROUP): Tab {
  return {
    id: `unified-${id}`,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function createSnapshot(ids: [string, ...string[]] = [LIVE, PENDING]): WorkspaceSessionSnapshot {
  const tabs = ids.map((id) => unifiedTab(id))
  const activeTabId = ids.at(-1)!
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: 'worktree:wt-1',
    activeWorktreeId: WT,
    activeTabId,
    tabsByWorktree: { [WT]: ids.map(terminalTab) },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: Object.fromEntries(
      ids.map((id) => [id, { root: null, activeLeafId: null, expandedLeafId: null }])
    ),
    activeTabIdByWorktree: { [WT]: activeTabId },
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    workspaceDocHistory: [],
    unifiedTabsByWorktree: { [WT]: tabs },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          activeTabId: unifiedTab(activeTabId).id,
          tabOrder: tabs.map((tab) => tab.id),
          recentTabIds: tabs.map((tab) => tab.id)
        }
      ]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WT]: GROUP },
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    closedTerminalTabTombstonesByTabId: {}
  }
}

describe('pending conversation workspace persistence', () => {
  it('keeps durable tabs and removes pending tabs, layouts, group history, and focus', () => {
    const snapshot = createSnapshot()
    const payload = buildWorkspaceSessionPayload(snapshot)

    expect(payload.tabsByWorktree[WT].map((tab) => tab.id)).toEqual([LIVE])
    expect(Object.keys(payload.terminalLayoutsByTabId)).toEqual([LIVE])
    expect(payload.activeTabId).toBeNull()
    expect(payload.activeTabIdByWorktree?.[WT]).toBeNull()
    expect(payload.tabGroups?.[WT]).toEqual([
      {
        id: GROUP,
        worktreeId: WT,
        activeTabId: null,
        tabOrder: [unifiedTab(LIVE).id],
        recentTabIds: [unifiedTab(LIVE).id]
      }
    ])
    const restored = buildHydratedTabState(
      workspaceSessionStateSchema.parse(JSON.parse(JSON.stringify(payload))),
      new Set([WT])
    )
    expect(restored.unifiedTabsByWorktree[WT].map((tab) => tab.entityId)).toEqual([LIVE])
    expect(snapshot.tabsByWorktree[WT]).toHaveLength(2)
    expect(snapshot.groupsByWorktree[WT][0].activeTabId).toBe(unifiedTab(PENDING).id)
  })

  it('cannot restore an empty shell or reconnect target from an unfinished conversation', () => {
    const snapshot = createSnapshot([PENDING])
    snapshot.lastKnownRelayPtyIdByTabId = { [PENDING]: 'ssh:connection-1@@session-pending' }
    snapshot.repos = [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#fff',
        addedAt: 1,
        connectionId: 'connection-1'
      }
    ]
    snapshot.worktreesByRepo = { 'repo-1': [{ id: WT, repoId: 'repo-1' } as never] }
    const payload = buildWorkspaceSessionPayload(snapshot)

    expect(payload.tabsByWorktree[WT]).toEqual([])
    expect(payload.terminalLayoutsByTabId).toEqual({})
    expect(payload.activeTabTypeByWorktree).toEqual({})
    expect(payload.unifiedTabs).toEqual({})
    expect(payload.tabGroups).toEqual({})
    expect(payload.tabGroupLayouts).toEqual({})
    expect(payload.activeGroupIdByWorktree).toEqual({})
    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
    expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
    const restored = buildHydratedTabState(
      workspaceSessionStateSchema.parse(JSON.parse(JSON.stringify(payload))),
      new Set([WT])
    )
    expect(Object.values(restored.unifiedTabsByWorktree).flat()).toEqual([])
    expect(Object.values(restored.groupsByWorktree).flat()).toEqual([])
  })

  it('collapses a split containing only a pending conversation onto the surviving group', () => {
    const snapshot = createSnapshot()
    const pendingGroup = 'group-pending'
    snapshot.unifiedTabsByWorktree[WT] = [unifiedTab(LIVE), unifiedTab(PENDING, pendingGroup)]
    snapshot.groupsByWorktree[WT] = [
      {
        id: GROUP,
        worktreeId: WT,
        activeTabId: unifiedTab(LIVE).id,
        tabOrder: [unifiedTab(LIVE).id]
      },
      {
        id: pendingGroup,
        worktreeId: WT,
        activeTabId: unifiedTab(PENDING).id,
        tabOrder: [unifiedTab(PENDING).id]
      }
    ]
    snapshot.activeGroupIdByWorktree[WT] = pendingGroup
    snapshot.layoutByWorktree[WT] = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: GROUP },
      second: { type: 'leaf', groupId: pendingGroup }
    }

    const payload = buildWorkspaceSessionPayload(snapshot)

    expect(payload.tabGroups?.[WT].map((group) => group.id)).toEqual([GROUP])
    expect(payload.activeGroupIdByWorktree?.[WT]).toBe(GROUP)
    expect(payload.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: GROUP })
  })

  it('persists the full tab after only its pending marker changes', () => {
    const snapshot = createSnapshot()
    const pendingPatch = buildWorkspaceSessionPatch(snapshot, ['tabsByWorktree'])

    expect(pendingPatch.tabsByWorktree?.[WT].map((tab) => tab.id)).toEqual([LIVE])
    expect(pendingPatch.unifiedTabs?.[WT].map((tab) => tab.entityId)).toEqual([LIVE])
    expect(pendingPatch.activeTabId).toBeNull()
    expect(pendingPatch.activeTabIdByWorktree?.[WT]).toBeNull()
    expect(pendingPatch.terminalLayoutsByTabId).not.toHaveProperty(PENDING)

    const before = buildWorkspaceSessionPayload(snapshot)
    delete snapshot.tabsByWorktree[WT][1].conversationLaunchPending
    const completedPatch = buildWorkspaceSessionPatch(snapshot, ['tabsByWorktree'])
    const restoredSession = workspaceSessionStateSchema.parse(
      JSON.parse(JSON.stringify({ ...before, ...completedPatch }))
    )
    const restored = buildHydratedTabState(restoredSession, new Set([WT]))

    expect(restoredSession.tabsByWorktree[WT].map((tab) => tab.id)).toEqual([LIVE, PENDING])
    expect(restoredSession.activeTabId).toBe(PENDING)
    expect(restoredSession.activeTabIdByWorktree?.[WT]).toBe(PENDING)
    expect(restored.unifiedTabsByWorktree[WT].map((tab) => tab.entityId)).toEqual([LIVE, PENDING])
    expect(restored.groupsByWorktree[WT][0].activeTabId).toBe(unifiedTab(PENDING).id)
  })

  it('preserves nonpending snapshot references and never writes the renderer-only marker', () => {
    const snapshot = createSnapshot([LIVE])
    snapshot.tabsByWorktree[WT][0].conversationLaunchPending = false

    expect(withoutPendingConversationTabs(snapshot)).toBe(snapshot)
    const payload = buildWorkspaceSessionPayload(snapshot)
    expect(payload.tabsByWorktree[WT]).toHaveLength(1)
    expect(payload.tabsByWorktree[WT][0]).not.toHaveProperty('conversationLaunchPending')
  })
})
