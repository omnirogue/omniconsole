import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/**
 * Folder-kind only when the target's own host has this repo and every such row is a folder; an
 * unhosted (legacy) target is local. Another host's same-id folder never counts.
 */
function isFolderTargetOnItsHost(
  target: Pick<Worktree, 'hostId' | 'repoId'>,
  repos: readonly Repo[]
): boolean {
  const hostId = target.hostId ?? LOCAL_EXECUTION_HOST_ID
  const owners = repos.filter(
    (repo) => repo.id === target.repoId && getRepoExecutionHostId(repo) === hostId
  )
  return owners.length > 0 && owners.every(isFolderRepo)
}

/**
 * Whether an ordinary confirm may force this target: only when the dialog showed its uncommitted
 * changes. A target with no changes shown (unread, or clean when read) gets a normal remove, so
 * Git refuses to drop work the person never saw and the Force Delete recovery takes over.
 */
export function canForceOnOrdinaryConfirm(
  target: Pick<Worktree, 'id' | 'hostId' | 'repoId' | 'isMainWorktree'>,
  args: {
    forceOnConfirm: boolean
    gitStatusByWorktree: Record<string, readonly unknown[] | undefined>
    gitStatusByWorktreeIdentity?: ReadonlyMap<string, readonly unknown[]>
    repos: readonly Repo[]
  }
): boolean {
  if (!args.forceOnConfirm) {
    return false
  }
  // Why: a folder workspace has no Git status; its dialog copy already names what is removed.
  if (isFolderTargetOnItsHost(target, args.repos)) {
    return true
  }
  const status = target.hostId
    ? args.gitStatusByWorktreeIdentity?.get(getWorktreeHostIdentity(target))
    : args.gitStatusByWorktree[target.id]
  return (status?.length ?? 0) > 0
}

/** The dialog's per-target force rule, reading the same git status the dialog shows. */
export function useConfirmForce(
  forceOnConfirm: boolean,
  repos: readonly Repo[],
  gitStatusByWorktreeIdentity: ReadonlyMap<string, readonly unknown[]> | undefined
): (target: Worktree) => boolean {
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  return useCallback(
    (target: Worktree) =>
      canForceOnOrdinaryConfirm(target, {
        forceOnConfirm,
        gitStatusByWorktree,
        gitStatusByWorktreeIdentity,
        repos
      }),
    [forceOnConfirm, gitStatusByWorktree, gitStatusByWorktreeIdentity, repos]
  )
}

/** Batch `forceFor`: looks each deleted target back up among the confirmed rows (host-qualified). */
export function forceForTargets(
  targets: readonly Worktree[],
  forceTarget: (target: Worktree) => boolean
): (target: Pick<Worktree, 'id' | 'hostId'>) => boolean {
  const byIdentity = new Map(targets.map((target) => [getWorktreeHostIdentity(target), target]))
  return (target) => {
    const item = byIdentity.get(getWorktreeHostIdentity(target))
    return item ? forceTarget(item) : false
  }
}
