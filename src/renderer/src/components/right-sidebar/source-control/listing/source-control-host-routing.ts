import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'

/** The one repo row with this id on this host; null when none or several match. */
export function findRepoOnHost(
  repos: readonly Repo[],
  repoId: string | null,
  hostId: ExecutionHostId | null | undefined
): Repo | null {
  if (!repoId || !hostId) {
    return null
  }
  const onHost = repos.filter(
    (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId
  )
  return onHost.length === 1 ? onHost[0] : null
}

/** A worktree's repo, preferring the row on its own host; host-qualified catalogs repeat ids. */
export function useRepoOnHost(
  repoId: string | null,
  hostId: ExecutionHostId | null | undefined
): Repo | null {
  const fallback = useRepoById(repoId)
  const onHost = useAppStore((s) => findRepoOnHost(s.repos, repoId, hostId))
  return onHost ?? fallback
}

/**
 * Connection and runtime for a git call on a worktree whose host is pinned (a folder's pick): its
 * own repo row decides, since a bare id resolves whichever same-id row it meets first. Null when
 * no host is pinned or no single row matches; callers then use the ordinary owner lookup.
 */
export function getPinnedHostGitRouting(
  repos: readonly Repo[],
  repoId: string | null,
  pinnedHostId: ExecutionHostId | undefined
): { connectionId: string | undefined; activeRuntimeEnvironmentId: string | null } | null {
  const repo = findRepoOnHost(repos, repoId, pinnedHostId)
  if (!repo) {
    return null
  }
  const host = parseExecutionHostId(pinnedHostId)
  return {
    connectionId: repo.connectionId?.trim() || undefined,
    activeRuntimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
  }
}

/** The owner's routing, unless a pinned host names its own repo row (see getPinnedHostGitRouting). */
export function withPinnedHostRouting<Settings extends { activeRuntimeEnvironmentId?: unknown }>(
  repos: readonly Repo[],
  repoId: string | null,
  pinnedHostId: ExecutionHostId | undefined,
  ownerConnectionId: string | undefined,
  ownerSettings: Settings
): { connectionId: string | undefined; settings: Settings } {
  const pinned = getPinnedHostGitRouting(repos, repoId, pinnedHostId)
  return pinned
    ? {
        connectionId: pinned.connectionId,
        settings: {
          ...ownerSettings,
          activeRuntimeEnvironmentId: pinned.activeRuntimeEnvironmentId
        }
      }
    : { connectionId: ownerConnectionId, settings: ownerSettings }
}
