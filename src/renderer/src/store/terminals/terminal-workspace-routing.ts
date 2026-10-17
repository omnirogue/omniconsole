import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../shared/local-windows-terminal-runtime'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'

export function isWindowsRendererRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

export function isAllowedRemoteWindowsTerminalShell(shell: string | undefined): boolean {
  return (
    shell === 'powershell.exe' ||
    shell === 'pwsh.exe' ||
    shell === 'cmd.exe' ||
    shell === 'wsl.exe' ||
    shell === WINDOWS_GIT_BASH_SHELL
  )
}

export function resolveCreatedTabShellOverride(
  explicitShellOverride: string | undefined,
  defaultWindowsShell: string | undefined,
  isRemoteWorktree: boolean,
  remotePlatform: NodeJS.Platform | null,
  isWslWorktree: boolean,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | undefined {
  if (isRemoteWorktree) {
    if (remotePlatform === 'win32' && isAllowedRemoteWindowsTerminalShell(explicitShellOverride)) {
      return explicitShellOverride
    }
    return undefined
  }
  if (isWindowsRendererRuntime()) {
    return resolveLocalWindowsTerminalShellOverrideForTab({
      explicitShellOverride,
      defaultWindowsShell,
      isWslWorktree,
      projectRuntime
    })
  }
  if (explicitShellOverride !== undefined) {
    return explicitShellOverride
  }
  return undefined
}

export function worktreeUsesWslPath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) => workspace.id === parsed.folderWorkspaceId
    )
    return folderWorkspace ? isWslUncPath(folderWorkspace.folderPath) : false
  }
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  return worktree ? isWslUncPath(worktree.path) : false
}

export function worktreeUsesRemoteConnection(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return Boolean(getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId))
  }
  const directRepoId = getRepoIdFromWorktreeId(worktreeId)
  const directRepo = state.repos.find((repo) => repo.id === directRepoId)
  if (directRepo) {
    return Boolean(directRepo.connectionId)
  }
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  return Boolean(repo?.connectionId)
}

export function getRemoteConnectionIdForWorktree(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): string | null | undefined {
  return getConnectionIdFromState(state, worktreeId)
}

export function resolveTerminalStopRuntimeEnvironmentId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}

/** Resolve before reserving any tab or starting an agent process. */
export function resolveTerminalCreationRoute(
  state: AppState,
  worktreeId: string,
  options: { allowPairedRuntime?: boolean } = {}
): {
  runtimeEnvironmentId: string | null
  connectionId: string | null
} {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { runtimeEnvironmentId: null, connectionId: null }
  }
  if (resolveWorktreeOperationRouteResult(state, worktreeId).kind === 'ambiguous') {
    throw new Error(
      translate(
        'terminal.creation.hostUnresolved',
        'The workspace execution host is unresolved. Nothing launched.'
      )
    )
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId) {
    if (options.allowPairedRuntime === false) {
      throw new Error(
        translate(
          'terminal.creation.pairedRouteRequired',
          'This workspace requires the paired terminal route. Nothing launched.'
        )
      )
    }
    return { runtimeEnvironmentId, connectionId: null }
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined || (connectionId === null && executionHostId !== 'local')) {
    throw new Error(
      translate(
        'terminal.creation.hostUnresolved',
        'The workspace execution host is unresolved. Nothing launched.'
      )
    )
  }
  if (connectionId && state.sshConnectionStates?.get(connectionId)?.status !== 'connected') {
    throw new Error(
      translate(
        'terminal.creation.hostDisconnected',
        'The workspace computer is disconnected. Nothing launched.'
      )
    )
  }
  return { runtimeEnvironmentId: null, connectionId }
}

export function tryTerminalCreationRoute(
  state: AppState,
  worktreeId: string
): ReturnType<typeof resolveTerminalCreationRoute> | null {
  try {
    return resolveTerminalCreationRoute(state, worktreeId)
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'terminal.creation.hostUnresolved',
            'The workspace execution host is unresolved. Nothing launched.'
          )
    )
    return null
  }
}
