import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceRunContext } from '../../../../shared/task-source-context'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
export function automationRepositoryContext(repo: Repo): WorkspaceRunContext | null {
  const setup = projectHostSetupProjectionFromRepos([repo]).setups[0]
  return setup
    ? {
        kind: 'workspace-run',
        projectId: setup.projectId,
        hostId: getRepoExecutionHostId(repo),
        projectHostSetupId: setup.id,
        repoId: repo.id,
        path: repo.path
      }
    : null
}
export function selectPrimaryAutomationRepository(
  repos: WorkspaceRunContext[] | undefined,
  repo?: Repo
): WorkspaceRunContext[] | undefined {
  if (!repos?.length || !repo) {
    return repos
  }
  const context = automationRepositoryContext(repo)
  return context ? [context, ...repos.filter((entry) => entry.repoId !== repo.id)] : repos
}
