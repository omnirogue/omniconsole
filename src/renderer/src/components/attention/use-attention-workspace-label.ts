import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { useAppStore } from '@/store'

/** The sidebar's label for the workspace a pane belongs to ("repo / worktree" or folder name). */
export function useAttentionWorkspaceLabel(worktreeId: string | null): string {
  const context = useAppStore(
    useShallow((state) => ({
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      sshConnectionStates: state.sshConnectionStates,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
    }))
  )
  return useMemo(
    () => (worktreeId ? sidebarSessionWorkspace(context, worktreeId).workspaceLabel : ''),
    [context, worktreeId]
  )
}
