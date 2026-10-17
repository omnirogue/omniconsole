import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function resolveModelDiscoveryLocalPath(
  store: Store,
  requestedPath: string
): Promise<string> {
  try {
    return await resolveRegisteredWorktreePath(requestedPath, store)
  } catch (error) {
    const folderWorkspaces =
      typeof store.getFolderWorkspaces === 'function' ? store.getFolderWorkspaces() : []
    const isFolderWorkspaceRoot = folderWorkspaces.some(
      (workspace) =>
        comparableLocalPath(workspace.folderPath) === comparableLocalPath(requestedPath)
    )
    if (!isFolderWorkspaceRoot) {
      throw error
    }
    return resolveAuthorizedPath(requestedPath, store)
  }
}
