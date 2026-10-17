import { resolveWorktreeHostedReview } from '@/components/dashboard/dashboard-card-context'
import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

/**
 * The row owner's pull or merge request from the provider-neutral dashboard caches.
 * A folder workspace or an ambiguous host/workspace match has none.
 */
export function sessionHostedReviewDetailsLookup(
  state: Pick<AppState, 'worktreesByRepo' | 'repos' | 'hostedReviewCache' | 'prCache' | 'settings'>
): (row: SessionSidebarTreeRow) => HostedReviewInfo | undefined {
  let worktrees: Worktree[] | null = null
  let repos: readonly Repo[] | null = null
  return (row) => {
    worktrees ??= Object.values(state.worktreesByRepo ?? {}).flat()
    const knownRepos = (repos ??= state.repos ?? [])
    const hostId = row.session.hostId ?? 'local'
    const ownedRepos = knownRepos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    const candidates = worktrees.filter((worktree) => {
      const matchingRepos = knownRepos.filter((entry) => entry.id === worktree.repoId)
      if (!worktree.hostId && matchingRepos.length !== 1) {
        return false
      }
      const repo = matchingRepos.length === 1 ? matchingRepos[0] : undefined
      return (
        worktree.id === row.session.worktreeId &&
        getWorktreeExecutionHostId(worktree, repo) === hostId
      )
    })
    const worktree = candidates.length === 1 ? candidates[0] : undefined
    const matchingRepos = worktree ? ownedRepos.filter((entry) => entry.id === worktree.repoId) : []
    const repo = matchingRepos.length === 1 ? matchingRepos[0] : undefined
    if (!worktree || !repo) {
      return undefined
    }
    return resolveWorktreeHostedReview(state, repo, worktree)
  }
}

export function sessionHostedReviewLookup(
  state: Parameters<typeof sessionHostedReviewDetailsLookup>[0]
): (row: SessionSidebarTreeRow) => boolean {
  const reviewFor = sessionHostedReviewDetailsLookup(state)
  return (row) => {
    const review = reviewFor(row)
    return review?.state === 'open' || review?.state === 'draft'
  }
}
