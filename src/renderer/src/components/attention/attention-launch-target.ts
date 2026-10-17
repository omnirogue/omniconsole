import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { getExecutionHostLabel, parseExecutionHostId } from '../../../../shared/execution-host'

type LaunchTarget = { workspace: string; host: string; remote: boolean }

export function useLaunchTarget(worktreeId: string | null): LaunchTarget | null {
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
  return useMemo(() => {
    if (!worktreeId) {
      return null
    }
    const resolved = sidebarSessionWorkspace(context, worktreeId)
    const hostKind = parseExecutionHostId(resolved.hostId)?.kind
    return {
      workspace: resolved.workspaceLabel,
      host: resolved.hostId ? getExecutionHostLabel(resolved.hostId) : '',
      remote: hostKind === 'ssh' || hostKind === 'runtime'
    }
  }, [context, worktreeId])
}

export function describeTarget(target: LaunchTarget | null): string {
  if (!target) {
    return translate(
      'attentionLauncher.noWorkspace',
      'Pick a workspace in the sidebar to start work here.'
    )
  }
  return target.host
    ? translate('attentionLauncher.target', 'in {{workspace}} · {{host}}', {
        workspace: target.workspace,
        host: target.host
      })
    : translate('attentionLauncher.targetNoHost', 'in {{workspace}}', {
        workspace: target.workspace
      })
}
