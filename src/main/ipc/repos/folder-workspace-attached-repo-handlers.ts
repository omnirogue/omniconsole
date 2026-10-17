import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../../persistence'
import type {
  FolderWorkspaceAttachedRepo,
  FolderWorkspaceAttachedReposById
} from '../../../shared/folder-workspace-attached-repos'
import type { FolderWorkspaceRepoDetection } from '../../../shared/folder-workspace-repo-candidates'
import {
  attachRegisteredRepoToFolderWorkspace,
  detectFolderWorkspaceRepos
} from '../../runtime/folder-workspace-attached-repo-runtime'
import { notifyReposChanged } from './repos-changed-notification'
import { scanNestedReposForIpc } from './nested-repo-scan-ipc'
import { parseProjectGroupIpcArgs } from './repo-ipc-arg-schemas'

const AttachArgs = z.object({
  folderWorkspaceId: z.string().min(1),
  repoId: z.string().min(1),
  source: z.enum(['detected-checkout', 'first-worktree', 'manual']).optional()
})
const DetachArgs = z.object({ folderWorkspaceId: z.string().min(1), key: z.string().min(1) })
const SelectorArgs = z.object({ folderWorkspaceId: z.string().min(1) })

export function registerFolderWorkspaceAttachedRepoHandlers(
  mainWindow: BrowserWindow,
  store: Store
): void {
  ipcMain.handle('folderWorkspaces:listAttachedRepos', (): FolderWorkspaceAttachedReposById =>
    store.getAllFolderWorkspaceAttachedRepos()
  )

  ipcMain.handle(
    'folderWorkspaces:attachRepo',
    (_event, rawArgs: unknown): FolderWorkspaceAttachedRepo[] | null => {
      const args = parseProjectGroupIpcArgs(AttachArgs, rawArgs, 'invalid_folder_attach_repo_args')
      const attached = attachRegisteredRepoToFolderWorkspace(store, args)
      if (attached) {
        notifyReposChanged(mainWindow)
      }
      return attached
    }
  )

  ipcMain.handle('folderWorkspaces:detachRepo', (_event, rawArgs: unknown): boolean => {
    const args = parseProjectGroupIpcArgs(DetachArgs, rawArgs, 'invalid_folder_detach_repo_args')
    const detached = store.detachRepoFromFolderWorkspace(args.folderWorkspaceId, args.key)
    if (detached) {
      notifyReposChanged(mainWindow)
    }
    return detached
  })

  ipcMain.handle(
    'folderWorkspaces:detectRepos',
    async (_event, rawArgs: unknown): Promise<FolderWorkspaceRepoDetection> => {
      const args = parseProjectGroupIpcArgs(
        SelectorArgs,
        rawArgs,
        'invalid_folder_detect_repos_args'
      )
      return detectFolderWorkspaceRepos(store, args.folderWorkspaceId, scanNestedReposForIpc)
    }
  )
}
