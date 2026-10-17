import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { SessionPrepRuntime } from './session-prep-runtime-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import { getProjectIdentityKey } from '../../shared/project-host-setup-projection'
import type { SessionPrepRepo, SessionPrepWorkspace } from './session-prep-host'

export function toPrepRepo(repo: Repo): SessionPrepRepo {
  return {
    selector: `id:${repo.id}`,
    name: repo.displayName,
    repositoryKey: getProjectIdentityKey(repo),
    id: repo.id,
    path: repo.path,
    isFolder: repo.kind === 'folder',
    isRemote: Boolean(repo.connectionId) || Boolean(repo.executionHostId?.startsWith('runtime:')),
    ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
    hostId: repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')
  }
}

export function repoWorkspace(repo: Repo, path: string): SessionPrepWorkspace {
  return {
    path,
    repoId: repo.id,
    isFolder: repo.kind === 'folder',
    isRemote: Boolean(repo.connectionId) || Boolean(repo.executionHostId?.startsWith('runtime:')),
    ...(repo.connectionId ? { connectionId: repo.connectionId } : {}),
    hostId: repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')
  }
}

export function folderWorkspace(folder: FolderWorkspace): SessionPrepWorkspace {
  return {
    path: folder.folderPath,
    repoId: folder.id,
    isFolder: true,
    isRemote:
      Boolean(folder.connectionId) || Boolean(folder.executionHostId?.startsWith('runtime:')),
    ...(folder.connectionId ? { connectionId: folder.connectionId } : {}),
    hostId: folder.executionHostId ?? (folder.connectionId ? `ssh:${folder.connectionId}` : 'local')
  }
}

export async function findWorktreeIdByName(
  runtime: SessionPrepRuntime,
  repoId: string,
  name: string
): Promise<string | null> {
  const listed = await runtime.listManagedWorktrees(`id:${repoId}`, 10_000)
  return listed.worktrees.find((worktree) => worktree.displayName === name)?.id ?? null
}

/** Panes use `folder:<id>`; the composer may still pass the bare folder id. */
export function sessionPrepFolderById(
  folders: readonly FolderWorkspace[],
  worktreeId: string
): FolderWorkspace | null {
  const scope = parseWorkspaceKey(worktreeId)
  const id = scope?.type === 'folder' ? scope.folderWorkspaceId : worktreeId
  return folders.find((entry) => entry.id === id) ?? null
}
