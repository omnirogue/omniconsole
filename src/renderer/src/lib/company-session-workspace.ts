import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getCompanyFolderHome } from './company-folder-home'
import {
  resolveCompanyFolder,
  resolveDomainFolder,
  type CompanyFolderIdentity
} from '../../../shared/company-folders'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { TuiAgent } from '../../../shared/tui-agent'

export type CompanySessionWorkspaceResult =
  | { ok: true; workspace: FolderWorkspace }
  | { ok: false; reason: 'folder-missing'; path: string }
  | { ok: false; reason: 'failed'; message: string }

function samePath(left: string | null | undefined, right: string): boolean {
  return Boolean(
    left && normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  )
}

function isLocalFolder(value: {
  connectionId?: string | null
  executionHostId?: string | null
}): boolean {
  return !value.connectionId && (!value.executionHostId || value.executionHostId === 'local')
}

/** Resolves the shared launch workspace without opening a terminal or changing the active view. */
export async function ensureCompanySessionWorkspace(args: {
  company: (CompanyFolderIdentity & { name: string }) | null
  domain: { id?: string | null; name: string } | null
  agent: TuiAgent | null
}): Promise<CompanySessionWorkspaceResult> {
  const state = useAppStore.getState()
  const home = await getCompanyFolderHome()
  if (!home) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.homeUnknown',
        'The home folder could not be read, so no session folder could be resolved.'
      )
    }
  }
  const settings = state.settings
  const companyFolder = resolveCompanyFolder({
    workRoot: settings?.companyWorkRoot,
    overrides: settings?.companyFolders,
    company: args.company ?? {},
    home
  })
  const targetFolder = args.domain
    ? resolveDomainFolder(companyFolder, args.domain.name)
    : companyFolder
  const companyName = args.company?.name ?? 'Work'
  const pathStatus = await window.api.folderWorkspaces
    .getPathStatus({ scope: 'path', path: targetFolder })
    .catch(() => null)
  // Why: a check that could not run is not a folder that exists; say so instead of launching blind.
  if (!pathStatus) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.folderUnknown',
        'The session folder could not be checked, so no agent was started.'
      )
    }
  }
  if (!pathStatus.exists) {
    return { ok: false, reason: 'folder-missing', path: targetFolder }
  }

  // Why: re-read after the awaits — a second Start click may have added the group or workspace.
  const current = useAppStore.getState()
  const existingWorkspace = current.folderWorkspaces.find(
    (workspace) => isLocalFolder(workspace) && samePath(workspace.folderPath, targetFolder)
  )
  let workspace = existingWorkspace ?? null
  if (!workspace) {
    // Why: a group named after the company from before folders were configured is the same group.
    const group =
      current.projectGroups.find(
        (candidate) => isLocalFolder(candidate) && samePath(candidate.parentPath, companyFolder)
      ) ??
      current.projectGroups.find(
        (candidate) =>
          isLocalFolder(candidate) && !candidate.parentPath && candidate.name === companyName
      ) ??
      (await current.createProjectGroup(companyName, {
        parentPath: companyFolder,
        runtimeEnvironmentId: null
      }))
    if (!group) {
      return {
        ok: false,
        reason: 'failed',
        message: translate(
          'companySessions.groupFailed',
          'The company folder could not be added to the sidebar, so no session was started.'
        )
      }
    }
    workspace = await useAppStore.getState().createFolderWorkspace(
      {
        projectGroupId: group.id,
        name: args.domain ? `${companyName} · ${args.domain.name}` : companyName,
        folderPath: targetFolder,
        ...(args.agent ? { createdWithAgent: args.agent } : {})
      },
      { runtimeEnvironmentId: null }
    )
  }
  if (!workspace) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.workspaceFailed',
        'The session folder could not be opened, so no agent was started.'
      )
    }
  }

  return { ok: true, workspace }
}
