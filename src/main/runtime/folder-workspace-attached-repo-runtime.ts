import type { Store } from '../persistence'
import {
  buildFolderWorkspaceAttachedRepo,
  isSameAttachedRepo,
  resolveAttachedRepo,
  selectAttachedRepoForCreate,
  type FolderWorkspaceAttachedRepo
} from '../../shared/folder-workspace-attached-repos'
import type {
  FolderWorkspaceRepoCandidate,
  FolderWorkspaceRepoDetection
} from '../../shared/folder-workspace-repo-candidates'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import type { NestedRepoScanResult } from '../../shared/project-group-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'

type AttachedRepoStore = Partial<
  Pick<
    Store,
    | 'getFolderWorkspace'
    | 'getFolderWorkspaceAttachedRepos'
    | 'attachRepoToFolderWorkspace'
    | 'getRepos'
  >
>

/** Attaches a registered git repo on the user's request (detected checkout or manual pick). */
export function attachRegisteredRepoToFolderWorkspace(
  store: AttachedRepoStore | null | undefined,
  args: {
    folderWorkspaceId: string
    repoId: string
    source?: FolderWorkspaceAttachedRepo['source']
  }
): FolderWorkspaceAttachedRepo[] | null {
  const repo = store?.getRepos?.().find((entry) => entry.id === args.repoId)
  if (!repo || isFolderRepo(repo)) {
    throw new Error('folder_attach_repo_not_git')
  }
  return (
    store?.attachRepoToFolderWorkspace?.(
      args.folderWorkspaceId,
      buildFolderWorkspaceAttachedRepo(repo, args.source ?? 'manual')
    ) ?? null
  )
}

// Why shallow and small: this runs when a folder opens, so it must stay cheap; deeper trees
// still attach automatically on a session's first worktree.
const DETECT_OPTIONS = { maxDepth: 2, maxRepos: 20, timeoutMs: 4000 }

/** Scans a folder for git checkouts; the desktop passes an SSH-aware one, the runtime a local one. */
export type FolderRepoScanner = (args: {
  path: string
  connectionId?: string
  options: typeof DETECT_OPTIONS
}) => Promise<NestedRepoScanResult>

/** Git checkouts under the folder (the folder itself included), matched to registered repos. */
export async function detectFolderWorkspaceRepos(
  store: AttachedRepoStore | null | undefined,
  folderWorkspaceId: string,
  scan: FolderRepoScanner
): Promise<FolderWorkspaceRepoDetection> {
  const workspace = store?.getFolderWorkspace?.(folderWorkspaceId)
  if (!workspace) {
    return { candidates: [], incomplete: false }
  }
  const connectionId = workspace.connectionId ?? null
  const result = await scan({
    path: workspace.folderPath,
    ...(connectionId ? { connectionId } : {}),
    options: DETECT_OPTIONS
  })
  const checkouts =
    result.selectedPathKind === 'git_repo'
      ? [{ path: result.selectedPath, displayName: workspace.name }, ...result.repos]
      : result.repos
  const attachments = store?.getFolderWorkspaceAttachedRepos?.(workspace.id) ?? []
  const gitRepos = (store?.getRepos?.() ?? []).filter(
    (repo) => !isFolderRepo(repo) && (repo.connectionId ?? null) === connectionId
  )
  const candidates: FolderWorkspaceRepoCandidate[] = checkouts.map((checkout) => {
    const target = normalizeRuntimePathForComparison(checkout.path)
    const repo = gitRepos.find((entry) => normalizeRuntimePathForComparison(entry.path) === target)
    // Why isSameAttachedRepo: a repo enriched since it attached keeps its id but not its key.
    const attached = repo
      ? attachments.some((entry) =>
          isSameAttachedRepo(entry, buildFolderWorkspaceAttachedRepo(repo, 'manual', 0))
        )
      : false
    return {
      path: checkout.path,
      displayName: repo?.displayName ?? checkout.displayName,
      connectionId,
      registeredRepoId: repo?.id ?? null,
      attached
    }
  })
  return { candidates, incomplete: result.truncated || result.timedOut || result.stopped }
}

/**
 * Attaches the repo a session just made a worktree in to the folder workspace that parented
 * it. Only explicit lineage reaches here, never a guess from cwd or file reads. Returns true
 * when the attachment is new.
 */
export function attachRepoOnFolderWorktreeCreate(
  store: AttachedRepoStore | null | undefined,
  parentWorkspaceKey: string,
  repo: Repo
): boolean {
  const scope = parseWorkspaceKey(parentWorkspaceKey)
  if (scope?.type !== 'folder' || isFolderRepo(repo) || !store?.attachRepoToFolderWorkspace) {
    return false
  }
  const before = store.getFolderWorkspaceAttachedRepos?.(scope.folderWorkspaceId) ?? []
  const after = store.attachRepoToFolderWorkspace(
    scope.folderWorkspaceId,
    buildFolderWorkspaceAttachedRepo(repo, 'first-worktree')
  )
  return after !== null && after.length > before.length
}

export type FolderWorkspaceRepoResolution =
  | { kind: 'resolved'; repoSelector: string; displayName: string }
  | { kind: 'fallthrough' }
  | {
      kind: 'error'
      /** Only `ambiguous` and `none-attached` let the CLI fall back to the repo it runs inside. */
      code: 'stale-attachment' | 'ambiguous' | 'none-attached'
      message: string
    }

/** Resolves `omni worktree create --repo <name>` (or no --repo) through a folder workspace's attached repos. */
export function resolveFolderWorkspaceRepoForCreate(
  store: AttachedRepoStore | null | undefined,
  folderWorkspace: string,
  name: string | undefined,
  cwdRepoId?: string
): FolderWorkspaceRepoResolution {
  const scope = parseWorkspaceKey(folderWorkspace)
  const folderWorkspaceId =
    scope?.type === 'folder' ? scope.folderWorkspaceId : scope ? null : folderWorkspace
  const workspace = folderWorkspaceId ? store?.getFolderWorkspace?.(folderWorkspaceId) : undefined
  if (!workspace) {
    return { kind: 'fallthrough' }
  }
  const attachments = store?.getFolderWorkspaceAttachedRepos?.(workspace.id) ?? []
  const repos = store?.getRepos?.() ?? []
  // Why: a session working inside its own worktree of an attached repo means that repo.
  const cwdRepo =
    !name && cwdRepoId
      ? attachments
          .map((attachment) => resolveAttachedRepo(attachment, repos))
          .find((repo) => repo?.id === cwdRepoId)
      : undefined
  if (cwdRepo) {
    return { kind: 'resolved', repoSelector: `id:${cwdRepo.id}`, displayName: cwdRepo.displayName }
  }
  const selection = selectAttachedRepoForCreate(attachments, name)
  if (selection.kind === 'match') {
    const repo = resolveAttachedRepo(selection.attachment, repos)
    if (!repo) {
      return {
        kind: 'error',
        code: 'stale-attachment',
        message: `"${selection.attachment.displayName}" is attached to ${workspace.name} but is no longer a project here. Add ${selection.attachment.repoPath} as a project again.`
      }
    }
    return { kind: 'resolved', repoSelector: `id:${repo.id}`, displayName: repo.displayName }
  }
  if (selection.kind === 'ambiguous') {
    return {
      kind: 'error',
      code: 'ambiguous',
      message: `${workspace.name} has several attached repos (${selection.names.join(', ')}). Pass --repo <name>.`
    }
  }
  if (selection.kind === 'none-attached' && !name) {
    return {
      kind: 'error',
      code: 'none-attached',
      message: `${workspace.name} has no attached repo yet. Pass --repo <name> once; it attaches to this folder for next time.`
    }
  }
  // Why: an unattached name falls through to the global lookup; that create then attaches it.
  return { kind: 'fallthrough' }
}

/**
 * The attached repo a Git job in a folder workspace runs against: the one whose identity is the
 * job's frozen repository. Null when the folder has no such repo attached.
 */
export function resolveFolderWorkspaceJobRepo(
  store: AttachedRepoStore | null | undefined,
  folderWorkspaceId: string,
  expectedIdentity: string
): Repo | null {
  const repos = store?.getRepos?.() ?? []
  for (const attachment of store?.getFolderWorkspaceAttachedRepos?.(folderWorkspaceId) ?? []) {
    const repo = resolveAttachedRepo(attachment, repos)
    const remote = repo?.gitRemoteIdentity?.remoteUrl
    const remoteIdentity = remote ? normalizeGitRemoteUrl(remote)?.toLowerCase() : null
    if (
      repo &&
      (attachment.gitIdentity === expectedIdentity || remoteIdentity === expectedIdentity)
    ) {
      return repo
    }
  }
  return null
}
