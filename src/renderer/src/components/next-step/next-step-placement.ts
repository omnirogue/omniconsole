import { translate } from '@/i18n/i18n'
import { useAppStore, type AppState } from '@/store'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/**
 * The id of the workspace a plan placed on `placement` runs in. Ids only: a folder
 * workspace mapped to a worktree is a fresh object on every call, and a zustand
 * selector returning one re-renders forever (React #185). The object is resolved
 * outside the selector by `findNextStepWorkspace`, through the store's cached getter.
 */
export function findNextStepWorkspaceId(
  state: AppState,
  sourceId: string,
  placement: ExecutionHostId
): string | null {
  const source = state.getKnownWorktreeById(sourceId)
  if (!source) {
    return null
  }
  const repoOf = (id: string): Repo | undefined => state.repos?.find((entry) => entry.id === id)
  const repo = repoOf(source.repoId)
  // Why: the work stays where the person is looking; only another computer moves it.
  if (getWorktreeExecutionHostId(source, repo) === placement) {
    return source.id
  }
  const sameRepos = new Set(
    (state.repos ?? [])
      .filter(
        (entry) =>
          entry.id === source.repoId ||
          (repo?.gitRemoteIdentity?.canonicalKey &&
            entry.gitRemoteIdentity?.canonicalKey === repo.gitRemoteIdentity.canonicalKey)
      )
      .map((entry) => entry.id)
  )
  sameRepos.add(source.repoId)
  const candidates = [
    ...Object.values(state.worktreesByRepo ?? {}).flat(),
    ...Object.values(state.detectedWorktreesByRepo ?? {}).flatMap((result) => result.worktrees),
    ...(state.folderWorkspaces ?? []).map(folderWorkspaceToWorktree)
  ]
  const onPlacement = (entry: Worktree): boolean =>
    !entry.isArchived &&
    sameRepos.has(entry.repoId) &&
    getWorktreeExecutionHostId(entry, repoOf(entry.repoId)) === placement
  // Why: moving the chain to another branch's checkout without saying so is a wrong answer.
  const sameBranch = source.branch
    ? candidates.find((entry) => onPlacement(entry) && entry.branch === source.branch)
    : undefined
  return (sameBranch ?? candidates.find(onPlacement))?.id ?? null
}

/** The workspace itself, resolved through the store's cached getter so its identity is stable. */
export function findNextStepWorkspace(
  state: AppState,
  sourceId: string,
  placement: ExecutionHostId
): Worktree | null {
  const id = findNextStepWorkspaceId(state, sourceId, placement)
  return id ? ((state.getKnownWorktreeById(id) as Worktree | undefined) ?? null) : null
}

export function nextStepPlacementRefusal(
  sourceId: string,
  placement: ExecutionHostId
): string | null {
  const state = useAppStore.getState()
  if (findNextStepWorkspace(state, sourceId, placement)) {
    return null
  }
  const source = state.getKnownWorktreeById(sourceId)
  const repo = state.repos?.find((entry) => entry.id === source?.repoId)
  const parsed = parseExecutionHostId(placement)
  const host =
    parsed?.kind === 'ssh'
      ? state.sshTargetLabels?.get(parsed.targetId)
      : parsed?.kind === 'runtime'
        ? state.runtimeEnvironments?.find((entry) => entry.id === parsed.environmentId)?.name
        : null
  return translate(
    'nextStep.noPlacedWorkspace',
    'No workspace for {{repo}} on {{host}} yet. Add one under Workspaces (🔧) and try again.',
    { repo: repo?.displayName ?? source?.displayName ?? sourceId, host: host ?? placement }
  )
}
