import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { useAppStore } from '@/store'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import {
  makeCreatedAgentWorktree,
  seedAlreadyActiveWorktree
} from '@/lib/worktree-activation-created-agent-test-state'
import { mergeDirectSshRemoteWorkspaceSession } from './remote-workspace-session-merge'

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

describe('pending conversation during direct SSH synchronization', () => {
  it.each(['empty host', 'another active host tab'] as const)(
    'preserves the draft, its group and focus through both hydrators for %s',
    (hostState) => {
      const worktree = makeCreatedAgentWorktree()
      seedAlreadyActiveWorktree(worktree)
      const tab = {
        ...useAppStore.getState().tabsByWorktree[worktree.id][0],
        ptyId: null,
        conversationLaunchPending: true
      }
      useAppStore.setState({
        tabsByWorktree: { [worktree.id]: [tab] },
        ptyIdsByTabId: {},
        terminalLayoutsByTabId: {}
      })
      const state = useAppStore.getState()
      const persisted = buildWorkspaceSessionPayload(state)
      expect(persisted.tabsByWorktree[worktree.id]).toEqual([])
      const current = buildWorkspaceSessionPayload(state, { includePendingConversations: true })
      const remote = getDefaultWorkspaceSession()
      if (hostState === 'another active host tab') {
        remote.activeRepoId = worktree.repoId
        remote.activeWorktreeId = worktree.id
        remote.activeTabId = 'host-tab'
        remote.activeTabIdByWorktree = { [worktree.id]: 'host-tab' }
        remote.tabsByWorktree = {
          [worktree.id]: [{ ...tab, id: 'host-tab', conversationLaunchPending: undefined }]
        }
      }
      const merged = mergeDirectSshRemoteWorkspaceSession(
        current,
        remote,
        new Set([worktree.id]),
        state.tabsByWorktree,
        new Set()
      )
      const replaceWorkspaceKeys = [worktree.id]
      state.hydrateWorkspaceSession(merged, { replaceWorkspaceKeys })
      useAppStore.getState().hydrateTabsSession(merged, { replaceWorkspaceKeys })

      const restored = useAppStore.getState()
      expect(
        restored.tabsByWorktree[worktree.id].find((entry) => entry.id === tab.id)
      ).toMatchObject({
        conversationLaunchPending: true,
        ptyId: null,
        pendingActivationSpawn: undefined
      })
      expect(restored.activeWorktreeId).toBe(worktree.id)
      expect(restored.activeTabId).toBe(tab.id)
      expect(restored.activeTabIdByWorktree[worktree.id]).toBe(tab.id)
      expect(restored.getActiveTab(worktree.id)?.entityId).toBe(tab.id)
      expect(
        restored.groupsByWorktree[worktree.id].find((group) => group.id === 'group-1')?.tabOrder
      ).toContain(tab.id)
      expect(restored.pendingStartupByTabId[tab.id]).toBeUndefined()
    }
  )
})
