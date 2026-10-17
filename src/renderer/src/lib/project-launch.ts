import { useMemo } from 'react'
import { create } from 'zustand'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { getSessionContext, launchSessionContextKey } from './session-context-store'
import { launchSkillsFor } from './project-launch-skills'
import {
  refreshProjectLaunchDocuments,
  withFreshProjectDocuments
} from './project-launch-documents'
import { projectFolderFor } from '../../../shared/session-project-folder'
import { repoCheckoutIn } from '../../../shared/project-repo-checkout'
import { getRepoGitIdentity } from '../../../shared/folder-workspace-attached-repos'
import { projectAgentTemplateId } from '../../../shared/project-agent-selection'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { ProjectSettings } from '../../../shared/project-settings'
import type { SessionFolderMetadata } from './session-folders'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'
import {
  resolveProjectLaunch,
  type ProjectLaunchHost,
  type ProjectLaunchResolution
} from '../../../shared/project-launch-inheritance'

export type LaunchProject = { folderId: string; name: string; settings: ProjectSettings }

/** The project a folder belongs to (Group-by project's rule), when it has settings. */
export function launchProjectIn(
  metadata: SessionFolderMetadata,
  folderId: string | null | undefined
): LaunchProject | null {
  const folder = projectFolderFor(metadata.folders, folderId)
  const settings = folder ? metadata.projects?.[folder.id] : undefined
  return folder && settings ? { folderId: folder.id, name: folder.name, settings } : null
}

export function launchProjectFor(folderId: string | null | undefined): LaunchProject | null {
  return launchProjectIn(useSessionFolders.getState().metadata, folderId)
}

/**
 * The open launcher's project and what the person changed for this one launch: items unticked
 * and stand-ins for items the target lacks. Lives while the menu is open, like its target pick.
 */
export const useLaunchProject = create<{
  folderId: string | null
  removed: readonly string[]
  replaced: Readonly<Record<string, SessionContextAttachment>>
  open: (folderId: string | null) => void
  toggleRemoved: (id: string) => void
  replace: (id: string, item: SessionContextAttachment | null) => void
}>()((set, get) => ({
  folderId: null,
  removed: [],
  replaced: {},
  open: (folderId) => {
    if (get().folderId !== folderId) {
      set({ folderId, removed: [], replaced: {} })
    }
  },
  toggleRemoved: (id) =>
    set(({ removed }) => ({
      removed: removed.includes(id) ? removed.filter((entry) => entry !== id) : [...removed, id]
    })),
  replace: (id, item) =>
    set(({ replaced, removed }) => {
      const { [id]: _previous, ...rest } = replaced
      return {
        replaced: item ? { ...rest, [id]: item } : rest,
        removed: removed.filter((entry) => entry !== id)
      }
    })
}))

/** Re-reads the open launcher project's documents; a launch awaits this before listing them. */
export function refreshOpenLaunchProjectDocuments(): Promise<void> | null {
  return refreshProjectLaunchDocuments(launchProjectFor(useLaunchProject.getState().folderId))
}

/** The open launcher's project, kept current as its settings change. */
export function useActiveLaunchProject(): LaunchProject | null {
  const folderId = useLaunchProject((state) => state.folderId)
  const metadata = useSessionFolders((state) => state.metadata)
  return useMemo(() => launchProjectIn(metadata, folderId), [metadata, folderId])
}

export function launchHostLabel(hostId: ExecutionHostId): string {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'ssh') {
    return useAppStore.getState().sshTargetLabels.get(parsed.targetId) ?? parsed.targetId
  }
  if (parsed?.kind === 'runtime') {
    return (
      useAppStore
        .getState()
        .runtimeEnvironments.find((environment) => environment.id === parsed.environmentId)?.name ??
      parsed.environmentId
    )
  }
  return translate('conversations.groupBy.thisComputer', 'This computer')
}

/** A repo's checkout on one host, from what this window knows about every host. */
export function repoCheckoutOnHost(gitIdentity: string, hostId: ExecutionHostId): string | null {
  const state = useAppStore.getState()
  const { projects, setups } = getProjectHostSetupProjectionFromState(state)
  const attached = Object.values(state.folderWorkspaceAttachedReposBySource).flatMap((byFolder) =>
    Object.values(byFolder ?? {}).flat()
  )
  return repoCheckoutIn({ repos: state.repos, projects, setups, attached }, gitIdentity, hostId)
}

export function projectLaunchHost(worktreeId: string | null): ProjectLaunchHost {
  return projectLaunchHostFor(
    getExecutionHostIdForWorktree(useAppStore.getState(), worktreeId),
    worktreeId
  )
}

/** A host a launch or a new workspace will run on; `worktreeId` names where its skills were read. */
export function projectLaunchHostFor(
  hostId: ExecutionHostId,
  worktreeId: string | null
): ProjectLaunchHost {
  const skills = launchSkillsFor(worktreeId, hostId)
  return {
    hostId,
    label: launchHostLabel(hostId),
    repoCheckout: (identity) => repoCheckoutOnHost(identity, hostId),
    skill: (name) => {
      if (skills === 'unknown') {
        return 'unknown'
      }
      const path = skills.get(name)
      return path ? { path } : null
    }
  }
}

/**
 * The workspace a project's New session starts in (plan §8 F5): the open one when it is the
 * project's, else a checkout of the project's repos on this computer, else on another host, else
 * a folder workspace with one attached (#895). Null when there is none yet.
 */
export function projectWorkspaceIn(
  state: Pick<
    AppState,
    'repos' | 'worktreesByRepo' | 'activeWorktreeId' | 'folderWorkspaceAttachedReposBySource'
  >,
  project: LaunchProject | null
): string | null {
  const identities = new Set(project?.settings.repos.map((repo) => repo.gitIdentity.toLowerCase()))
  if (!identities.size) {
    return null
  }
  const checkouts = state.repos
    .filter((repo) => identities.has(getRepoGitIdentity(repo)))
    .flatMap((repo) =>
      (state.worktreesByRepo[repo.id] ?? []).map((worktree) => ({
        id: worktree.id,
        local: getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      }))
    )
  const active = checkouts.find((checkout) => checkout.id === state.activeWorktreeId)
  const found = active ?? checkouts.find((checkout) => checkout.local) ?? checkouts[0]
  if (found) {
    return found.id
  }
  for (const byFolder of Object.values(state.folderWorkspaceAttachedReposBySource)) {
    for (const [folderWorkspaceId, repos] of Object.entries(byFolder ?? {})) {
      if (repos.some((repo) => identities.has(repo.gitIdentity))) {
        return `folder:${folderWorkspaceId}`
      }
    }
  }
  return null
}

/** What a launch from the open launcher inherits, or null outside a project. */
export function resolveLaunchProject(
  worktreeId: string | null,
  templateId: string | null
): (ProjectLaunchResolution & { project: LaunchProject; hostLabel: string }) | null {
  const { folderId, removed, replaced } = useLaunchProject.getState()
  const saved = launchProjectFor(folderId)
  if (!saved) {
    return null
  }
  const project = withFreshProjectDocuments(saved)
  const host = projectLaunchHost(worktreeId)
  const resolution = resolveProjectLaunch({
    project,
    launch: getSessionContext(launchSessionContextKey(worktreeId)),
    session: [],
    removed,
    replaced,
    host,
    templateId: projectAgentTemplateId(
      project.settings.agents,
      useAppStore.getState().settings?.agentTemplates,
      templateId
    )
  })
  return { ...resolution, project, hostLabel: host.label }
}
