import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { FolderAttachedReposStatus } from '@/store/folder-workspaces/folder-workspace-attached-repo-actions'
import {
  resolveAttachedRepo,
  type FolderWorkspaceAttachedRepo
} from '../../../shared/folder-workspace-attached-repos'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  getAttachedWorktreesForFolderWorkspace,
  getWorktreeActivityTime
} from '@/components/right-sidebar/folder-workspace-attached-worktrees'

export type FolderGitTargetCandidate = {
  worktree: Worktree
  /** A worktree a session in this folder made, or an attached repo's own checkout. */
  kind: 'session-worktree' | 'repo-checkout'
}

/**
 * Where git features point when the active workspace is a folder: the session's own worktree
 * (most recently active first) or an attached repo's checkout. `needs-attach` means nothing is
 * attached; `unavailable` means a repo is attached but its catalog is not loaded here yet;
 * `attachments-unknown` means the owning host has not told us what is attached.
 */
export type FolderGitTarget =
  | { kind: 'not-folder' }
  | { kind: 'needs-attach'; folderWorkspaceId: string }
  | { kind: 'unavailable'; folderWorkspaceId: string; repoNames: string[] }
  | { kind: 'attachments-unknown'; folderWorkspaceId: string; failed: boolean }
  | {
      kind: 'target'
      folderWorkspaceId: string
      worktree: Worktree
      candidates: FolderGitTargetCandidate[]
    }

export function resolveFolderGitTarget(args: {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreesByRepo: Record<string, readonly Worktree[]>
  repos: readonly Repo[]
  /** This folder's attachments, read from the host that owns it. */
  attachedRepos: readonly FolderWorkspaceAttachedRepo[]
  /** Whether `attachedRepos` is known; an empty list only means "none attached" when ready. */
  attachedReposStatus?: FolderAttachedReposStatus
  /** Host-qualified identity (or bare id) the person picked in "Changes in". */
  chosenWorktreeId: string | undefined
}): FolderGitTarget {
  const { folderWorkspace, childWorktrees, lineageChildrenByParentId } =
    getAttachedWorktreesForFolderWorkspace(args)
  if (!folderWorkspace) {
    return { kind: 'not-folder' }
  }
  const sessionWorktrees: Worktree[] = []
  const seen = new Set<string>()
  const addSession = (worktree: Worktree): void => {
    const identity = getWorktreeHostIdentity(worktree)
    if (!worktree.isArchived && !seen.has(identity)) {
      seen.add(identity)
      sessionWorktrees.push(worktree)
      for (const child of lineageChildrenByParentId.get(worktree.id) ?? []) {
        addSession(child)
      }
    }
  }
  for (const worktree of childWorktrees) {
    addSession(worktree)
  }
  // Why: the default is the worktree worked in last, whether a child or a descendant of one.
  sessionWorktrees.sort(
    (left, right) => getWorktreeActivityTime(right) - getWorktreeActivityTime(left)
  )
  const candidates: FolderGitTargetCandidate[] = sessionWorktrees.map((worktree) => ({
    worktree,
    kind: 'session-worktree'
  }))
  for (const attachment of args.attachedRepos) {
    const repo = resolveAttachedRepo(attachment, args.repos)
    // Why the host check: host-qualified catalogs can repeat repo and worktree ids across hosts.
    const checkout = repo
      ? args.worktreesByRepo[repo.id]?.find(
          (worktree) =>
            worktree.isMainWorktree &&
            (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === attachment.hostId
        )
      : undefined
    if (checkout && !seen.has(getWorktreeHostIdentity(checkout))) {
      seen.add(getWorktreeHostIdentity(checkout))
      candidates.push({ worktree: checkout, kind: 'repo-checkout' })
    }
  }
  if (candidates.length === 0) {
    const status = args.attachedReposStatus ?? 'ready'
    if (args.attachedRepos.length === 0 && status !== 'ready') {
      return {
        kind: 'attachments-unknown',
        folderWorkspaceId: folderWorkspace.id,
        failed: status === 'failed'
      }
    }
    return args.attachedRepos.length > 0
      ? {
          kind: 'unavailable',
          folderWorkspaceId: folderWorkspace.id,
          repoNames: args.attachedRepos.map((attachment) => attachment.displayName)
        }
      : { kind: 'needs-attach', folderWorkspaceId: folderWorkspace.id }
  }
  const chosen = candidates.find(
    (candidate) =>
      getWorktreeHostIdentity(candidate.worktree) === args.chosenWorktreeId ||
      candidate.worktree.id === args.chosenWorktreeId
  )
  return {
    kind: 'target',
    folderWorkspaceId: folderWorkspace.id,
    worktree: (chosen ?? candidates[0]).worktree,
    candidates
  }
}
