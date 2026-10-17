import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  classifySessionInventoryWorkspaceRecords,
  exclusiveRuntimeOwnerOfWorkspaceRecords,
  type SessionInventoryWorkspaceProvenance,
  type SessionInventoryWorkspaceRecords
} from '../../../shared/session-inventory-ownership'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

type OwnerRepos = NonNullable<WorktreeRuntimeOwnerState['repos']>
type OwnerWorktrees = NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']>
type WorktreeRecord = OwnerWorktrees[string][number]

// Why: publication and every receiver frame read this; index immutable catalog slices once.
const repoHostsCache = new WeakMap<OwnerRepos, ReadonlyMap<string, ExecutionHostId[]>>()
const worktreeHostsCache = new WeakMap<object, ReadonlyMap<string, ExecutionHostId[]>>()
const NO_REPOS: OwnerRepos = []

function getRepoHosts(repos: OwnerRepos): ReadonlyMap<string, ExecutionHostId[]> {
  let index = repoHostsCache.get(repos)
  if (!index) {
    const next = new Map<string, ExecutionHostId[]>()
    for (const repo of repos) {
      next.set(repo.id, [...(next.get(repo.id) ?? []), getRepoExecutionHostId(repo)])
    }
    index = next
    repoHostsCache.set(repos, index)
  }
  return index
}

function worktreeRecordHost(worktree: WorktreeRecord): ExecutionHostId | null {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  return runtimeOwner
    ? toRuntimeExecutionHostId(runtimeOwner)
    : (parseExecutionHostId(worktree.hostId)?.id ?? null)
}

function indexWorktreeHosts(
  listings: Iterable<readonly WorktreeRecord[]>
): ReadonlyMap<string, ExecutionHostId[]> {
  const next = new Map<string, ExecutionHostId[]>()
  for (const worktrees of listings) {
    for (const worktree of worktrees) {
      const host = worktreeRecordHost(worktree)
      if (host) {
        next.set(worktree.id, [...(next.get(worktree.id) ?? []), host])
      }
    }
  }
  return next
}

function getWorktreeHosts(state: WorktreeRuntimeOwnerState, worktreeId: string): ExecutionHostId[] {
  const hosts: ExecutionHostId[] = []
  if (state.worktreesByRepo) {
    let index = worktreeHostsCache.get(state.worktreesByRepo)
    if (!index) {
      index = indexWorktreeHosts(Object.values(state.worktreesByRepo))
      worktreeHostsCache.set(state.worktreesByRepo, index)
    }
    hosts.push(...(index.get(worktreeId) ?? []))
  }
  if (state.detectedWorktreesByRepo) {
    let index = worktreeHostsCache.get(state.detectedWorktreesByRepo)
    if (!index) {
      index = indexWorktreeHosts(
        Object.values(state.detectedWorktreesByRepo).map((listing) => listing.worktrees)
      )
      worktreeHostsCache.set(state.detectedWorktreesByRepo, index)
    }
    hosts.push(...(index.get(worktreeId) ?? []))
  }
  return hosts
}

function getFolderHosts(state: WorktreeRuntimeOwnerState, folderWorkspaceId: string): string[] {
  const hosts = (state.folderWorkspaces ?? [])
    .filter((workspace) => workspace.id === folderWorkspaceId)
    .map((workspace) => {
      const group = state.projectGroups?.find((entry) => entry.id === workspace.projectGroupId)
      const connectionId = workspace.connectionId?.trim() || group?.connectionId?.trim()
      return (
        parseExecutionHostId(workspace.executionHostId ?? group?.executionHostId)?.id ??
        (connectionId ? toSshExecutionHostId(connectionId) : null)
      )
    })
    .filter((host): host is ExecutionHostId => host !== null)
  if (hosts.length > 0) {
    return hosts
  }
  // Why: before folder catalogs load, the restored session partition is the saved owner record.
  const restored = Object.entries(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {}).find(
    ([key]) => {
      const scope = parseWorkspaceKey(key)
      return scope?.type === 'folder' && scope.folderWorkspaceId === folderWorkspaceId
    }
  )?.[1]
  return restored ? [restored] : []
}

function getWorkspaceRecords(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): SessionInventoryWorkspaceRecords {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return { workspaceHostIds: getFolderHosts(state, scope.folderWorkspaceId), repoHostIds: [] }
  }
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  return {
    workspaceHostIds: getWorktreeHosts(state, rawWorktreeId),
    repoHostIds:
      getRepoHosts(state.repos ?? NO_REPOS).get(getRepoIdFromWorktreeId(rawWorktreeId)) ?? []
  }
}

/**
 * Who owns a workspace's session inventory, from saved catalog records only.
 *
 * Why never the open workspace's route: the host a window currently has open is navigation, not
 * ownership — reading it made a workspace published by two computers look exclusively owned by
 * whichever copy was open, so the other owner's frames were dropped and its rows evicted. A
 * missing optional field or a path that does not exist here never makes a workspace foreign
 * (PR #1035); records naming both a paired runtime and another owner are unresolved. The runtime
 * applies the same records predicate (src/shared/session-inventory-ownership.ts).
 */
export function getSessionInventoryWorkspaceProvenance(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): SessionInventoryWorkspaceProvenance {
  return classifySessionInventoryWorkspaceRecords(getWorkspaceRecords(state, worktreeId))
}

/** The paired environment the saved catalog credits with the workspace exclusively, if any. */
export function getCatalogRuntimeOwnerEnvironmentId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): string | null {
  return exclusiveRuntimeOwnerOfWorkspaceRecords(getWorkspaceRecords(state, worktreeId))
}
