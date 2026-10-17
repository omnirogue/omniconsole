import { homedir } from 'node:os'
import { resolveCompanyFolder } from '../../shared/company-folders'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

/**
 * Where a terminal request starts when its own workspace is unknown: the registered local folder
 * at the company Work root, as the Work composer's default. Never an SSH or paired folder.
 */
export function sessionPrepDefaultSource(
  folders: FolderWorkspace[],
  settings: Pick<GlobalSettings, 'companyWorkRoot' | 'companyFolders'> | null | undefined,
  home: string = homedir()
): string | null {
  const root = normalizeRuntimePathForComparison(
    resolveCompanyFolder({
      workRoot: settings?.companyWorkRoot,
      overrides: settings?.companyFolders,
      company: {},
      home
    })
  )
  const folder = folders.find(
    (entry) =>
      !entry.isArchived &&
      !entry.connectionId &&
      (!entry.executionHostId || entry.executionHostId === 'local') &&
      normalizeRuntimePathForComparison(entry.folderPath) === root
  )
  return folder ? folderWorkspaceKey(folder.id) : null
}
