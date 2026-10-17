import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { splitGitRemoteKey } from '../../../../shared/git-remote-identity'

/** A local workspace the picker can search in, and the GitHub repository it is a copy of. */
export type WorkflowContextRoot = {
  worktreeId: string
  label: string
  path: string
  branch: string
  /** owner/name, lower case, when the workspace's remote is on github.com. */
  github?: string
}

/** A repository on this computer: no SSH target and no other execution host. */
function isLocal(repo: Repo): boolean {
  return !repo.connectionId && (!repo.executionHostId || repo.executionHostId === 'local')
}

function githubName(repo: Repo): string | undefined {
  const parts = splitGitRemoteKey(repo.gitRemoteIdentity?.canonicalKey, (host) => host)
  return parts?.host === 'github.com' ? parts.tail.replace(/\.git$/, '') : undefined
}

/** Every local workspace of every local repository, archived ones left out. */
export function workflowContextLocalRoots(
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
): WorkflowContextRoot[] {
  return repos.filter(isLocal).flatMap((repo) => {
    const github = githubName(repo)
    return (worktreesByRepo[repo.id] ?? [])
      .filter((worktree) => !worktree.isArchived && !worktree.isBare)
      .map((worktree) => {
        const branch = (worktree.branch ?? '').replace(/^refs\/heads\//, '')
        return {
          worktreeId: worktree.id,
          label: branch ? `${repo.displayName} · ${branch}` : repo.displayName,
          path: worktree.path,
          branch,
          ...(github ? { github } : {})
        }
      })
  })
}

/** Local workspaces that are copies of the GitHub repository `repo` (owner/name). */
export function workflowContextLocalCopies(
  roots: readonly WorkflowContextRoot[],
  repo: string
): WorkflowContextRoot[] {
  const wanted = repo.toLowerCase()
  return roots.filter((root) => root.github === wanted)
}

/**
 * Folders among `files` (paths relative to a workspace) whose own name holds the query, the
 * shortest first, so a search for "docs" offers the docs folder itself as well as its files.
 */
export function workflowContextFolderMatches(
  files: readonly string[],
  query: string,
  limit = 8
): string[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) {
    return []
  }
  const folders = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      if (parts[depth - 1]!.toLowerCase().includes(wanted)) {
        folders.add(parts.slice(0, depth).join('/'))
      }
    }
  }
  return [...folders]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
    .slice(0, limit)
}
