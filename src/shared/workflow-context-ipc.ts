/** Renderer → main channels for the workflow context picker (this computer only). */
export const WORKFLOW_CONTEXT_CHANNELS = {
  pickPaths: 'workflowContext:pickPaths',
  searchRepos: 'workflowContext:searchRepos',
  listBranches: 'workflowContext:listBranches'
} as const

/** One repository a search or the person's own list found. */
export type WorkflowGitHubRepoHit = { repo: string; description: string; defaultBranch: string }

export type WorkflowGitHubReposResult = { repos: WorkflowGitHubRepoHit[] } | { error: string }
export type WorkflowGitHubBranchesResult = { branches: string[] } | { error: string }
