import { getRepoExecutionHostId } from './execution-host'
import {
  getRepoGitIdentity,
  type FolderWorkspaceAttachedRepo
} from './folder-workspace-attached-repos'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'

/** What one computer knows about where repos are checked out, on every host it can see. */
export type RepoCheckoutSources = {
  repos: readonly Repo[]
  projects: readonly Pick<Project, 'id' | 'gitRemoteIdentity'>[]
  setups: readonly Pick<ProjectHostSetup, 'projectId' | 'hostId' | 'path'>[]
  attached: readonly Pick<FolderWorkspaceAttachedRepo, 'hostId' | 'gitIdentity' | 'repoPath'>[]
}

/**
 * A project repo's checkout on one host (plan §8 F4): a registered repo with that identity there,
 * else the project's host setup for that host, else a folder workspace's attached repo (#895).
 */
export function repoCheckoutIn(
  sources: RepoCheckoutSources,
  gitIdentity: string,
  hostId: string
): string | null {
  const identity = gitIdentity.toLowerCase()
  const repo = sources.repos.find(
    (entry) => getRepoExecutionHostId(entry) === hostId && getRepoGitIdentity(entry) === identity
  )
  if (repo) {
    return repo.path
  }
  const project = sources.projects.find(
    (entry) => entry.gitRemoteIdentity?.canonicalKey?.toLowerCase() === identity
  )
  const setup = project
    ? sources.setups.find((entry) => entry.projectId === project.id && entry.hostId === hostId)
    : undefined
  if (setup?.path) {
    return setup.path
  }
  return (
    sources.attached.find((entry) => entry.hostId === hostId && entry.gitIdentity === identity)
      ?.repoPath ?? null
  )
}
