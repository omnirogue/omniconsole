import { getExecutionHostLabel, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { FolderWorkspaceAttachedReposById } from '../../shared/folder-workspace-attached-repos'
import { resolveProjectLaunch } from '../../shared/project-launch-inheritance'
import { repoCheckoutIn } from '../../shared/project-repo-checkout'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type {
  SessionProjectLaunch,
  SessionProjectReadResult
} from '../../shared/session-project-cli'
import type { SessionFolderRelayRequest } from '../../shared/session-folder-cli'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { resolveContextDocument } from '../artifacts/context-document-search'
import {
  refreshProjectDocuments,
  type ResolveProjectDocument
} from '../../shared/project-document-refresh'

/** What main reads to resolve a project launch; the runtime provides each. */
export type ProjectLaunchRuntime = {
  requestSessionFolders(request: SessionFolderRelayRequest): Promise<unknown>
  listRepos(): Repo[]
  listProjects(): Project[]
  listProjectHostSetups(): ProjectHostSetup[]
  listFolderWorkspaceAttachedRepos(): FolderWorkspaceAttachedReposById
  /** This computer's installed skills; never another host's. */
  discoverLocalSkills?(): Promise<SkillDiscoveryResult>
  /** Re-reads a Slite or OmniOS document with this desktop's credentials. */
  resolveDocument?: ResolveProjectDocument
}

export function projectLaunchRuntime(runtime: OrcaRuntimeService): ProjectLaunchRuntime {
  return {
    requestSessionFolders: (request) => runtime.requestSessionFolders(request),
    listRepos: () => runtime.listRepos(),
    listProjects: () => runtime.listProjects(),
    listProjectHostSetups: () => runtime.listProjectHostSetups(),
    listFolderWorkspaceAttachedRepos: () => runtime.listFolderWorkspaceAttachedRepos(),
    discoverLocalSkills: async () => {
      const target = resolveSkillDiscoveryTarget(undefined)
      return discoverSkillsOnTarget(target, runtime.listRepos(), {
        providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(target)
      })
    },
    resolveDocument: (request) => resolveContextDocument(request, runtime)
  }
}

/**
 * A project launch as main resolves it for the CLI and dispatch paths (plan §8 F4). Null when the
 * folder is in no project or its project has no settings. Skills are only readable on this
 * computer: an SSH host's are `unknown` (skills.discover scans native or WSL roots only). Slite
 * and OmniOS documents are re-read first; one that can't be read keeps its saved copy, in `notes`.
 */
export async function resolveProjectLaunchInMain(
  runtime: ProjectLaunchRuntime,
  args: { folder: string; host: string; worktreeId?: string; templateId?: string }
): Promise<SessionProjectLaunch | null> {
  const read = (await runtime.requestSessionFolders({
    kind: 'readProject',
    folder: args.folder,
    ...(args.worktreeId ? { worktreeId: args.worktreeId } : {})
  })) as SessionProjectReadResult
  const saved = read.project?.settings
  if (!read.project || !saved) {
    return null
  }
  const documents = runtime.resolveDocument
    ? await refreshProjectDocuments(saved.attachments, runtime.resolveDocument)
    : { items: saved.attachments, notes: [] }
  const settings = { ...saved, attachments: documents.items }
  const sources = {
    repos: runtime.listRepos(),
    projects: runtime.listProjects(),
    setups: runtime.listProjectHostSetups(),
    attached: Object.values(runtime.listFolderWorkspaceAttachedRepos()).flat()
  }
  const skills =
    args.host === LOCAL_EXECUTION_HOST_ID && runtime.discoverLocalSkills
      ? await runtime
          .discoverLocalSkills()
          .then(
            (result) => new Map(result.skills.map((skill) => [skill.name, skill.skillFilePath]))
          )
          .catch(() => 'unknown' as const)
      : ('unknown' as const)
  const label = getExecutionHostLabel(args.host as Parameters<typeof getExecutionHostLabel>[0])
  const resolution = resolveProjectLaunch({
    project: { folderId: read.project.folderId, name: read.project.name, settings },
    launch: read.launch ?? [],
    session: [],
    removed: [],
    host: {
      hostId: args.host,
      label,
      repoCheckout: (identity) => repoCheckoutIn(sources, identity, args.host),
      skill: (name) => {
        if (skills === 'unknown') {
          return 'unknown'
        }
        const path = skills.get(name)
        return path ? { path } : null
      }
    },
    templateId: args.templateId ?? null
  })
  return {
    project: { folderId: read.project.folderId, name: read.project.name },
    projectLine: resolution.projectLine,
    host: { id: args.host, label },
    attachments: resolution.attachments,
    inherited: resolution.inherited,
    notOnHost: resolution.notOnHost,
    agent: resolution.agent,
    roster: resolution.roster,
    error: resolution.error,
    ...(documents.notes.length ? { notes: documents.notes } : {})
  }
}
