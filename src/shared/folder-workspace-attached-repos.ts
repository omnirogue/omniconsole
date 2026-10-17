import type { ExecutionHostId } from './execution-host'
import { getRepoExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'
import { normalizeRuntimePathForComparison } from './cross-platform-path'

/**
 * A repo a folder workspace works on. The folder is the view; the repo is where code
 * sessions make their worktrees. Keyed on the repo's git identity plus its execution
 * host, so the same repo can sit in many folders and two hosts' clones never merge.
 */
export type FolderWorkspaceAttachedRepo = {
  /** `${hostId}|${gitIdentity}`: stable across re-registering the same clone. */
  key: string
  /** Remote canonical key (`github.com/owner/repo`) when known, else `path:<checkout>`. */
  gitIdentity: string
  hostId: ExecutionHostId
  /** Registered repo that carries this identity on this host; re-resolved on use. */
  repoId: string
  repoPath: string
  displayName: string
  /** How it got attached: the user accepted a detected checkout, or a session's first worktree. */
  source: 'detected-checkout' | 'first-worktree' | 'manual'
  attachedAt: number
}

export type FolderWorkspaceAttachedReposById = Record<string, FolderWorkspaceAttachedRepo[]>

export function getRepoGitIdentity(repo: Pick<Repo, 'path' | 'gitRemoteIdentity'>): string {
  const canonical = repo.gitRemoteIdentity?.canonicalKey?.trim().toLowerCase()
  // Why normalized: `C:\\Work\\Repo` and `c:/work/repo/` are the same checkout.
  return canonical ? canonical : `path:${normalizeRuntimePathForComparison(repo.path)}`
}

export function getAttachedRepoKey(
  repo: Pick<Repo, 'path' | 'gitRemoteIdentity' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(repo)}|${getRepoGitIdentity(repo)}`
}

export function buildFolderWorkspaceAttachedRepo(
  repo: Repo,
  source: FolderWorkspaceAttachedRepo['source'],
  now = Date.now()
): FolderWorkspaceAttachedRepo {
  return {
    key: getAttachedRepoKey(repo),
    gitIdentity: getRepoGitIdentity(repo),
    hostId: getRepoExecutionHostId(repo),
    repoId: repo.id,
    repoPath: repo.path,
    displayName: repo.displayName,
    source,
    attachedAt: now
  }
}

/**
 * The registered repo an attachment points at: the same repo id on the same host (its identity
 * may have been enriched since, e.g. a remote was added), else the same identity on that host.
 */
export function resolveAttachedRepo<T extends Repo>(
  attachment: Pick<FolderWorkspaceAttachedRepo, 'key' | 'repoId' | 'hostId'>,
  repos: readonly T[]
): T | undefined {
  return (
    repos.find(
      (repo) => repo.id === attachment.repoId && getRepoExecutionHostId(repo) === attachment.hostId
    ) ?? repos.find((repo) => getAttachedRepoKey(repo) === attachment.key)
  )
}

/** Same attachment: same identity on the host, or the same registered repo whose identity changed. */
export function isSameAttachedRepo(
  left: Pick<FolderWorkspaceAttachedRepo, 'key' | 'repoId' | 'hostId'>,
  right: Pick<FolderWorkspaceAttachedRepo, 'key' | 'repoId' | 'hostId'>
): boolean {
  return left.key === right.key || (left.repoId === right.repoId && left.hostId === right.hostId)
}

/**
 * The folder's list with this attachment in it, or null when nothing changes. A repeat attach keeps
 * the first source and time; a re-registered or enriched repo refreshes its identity in place.
 */
export function withAttachedRepo(
  current: readonly FolderWorkspaceAttachedRepo[],
  attachment: FolderWorkspaceAttachedRepo
): FolderWorkspaceAttachedRepo[] | null {
  const existing = current.find((entry) => isSameAttachedRepo(entry, attachment))
  if (!existing) {
    return [...current, attachment]
  }
  if (
    existing.key === attachment.key &&
    existing.repoId === attachment.repoId &&
    existing.repoPath === attachment.repoPath
  ) {
    return null
  }
  const { key, gitIdentity, repoId, repoPath, displayName } = attachment
  const rekeyed = current.map((entry) =>
    entry === existing ? { ...entry, key, gitIdentity, repoId, repoPath, displayName } : entry
  )
  // Why: re-keying can meet a row already holding that key (another clone of the same remote);
  // keep one row per key, the earliest attached, so detach and selection stay unambiguous.
  return dedupeAttachedReposByKey(rekeyed)
}

function dedupeAttachedReposByKey(
  entries: readonly FolderWorkspaceAttachedRepo[]
): FolderWorkspaceAttachedRepo[] {
  const byKey = new Map<string, FolderWorkspaceAttachedRepo>()
  for (const entry of entries) {
    const kept = byKey.get(entry.key)
    if (!kept || entry.attachedAt < kept.attachedAt) {
      byKey.set(entry.key, entry)
    }
  }
  return entries.filter((entry) => byKey.get(entry.key) === entry)
}

const SOURCES = new Set<FolderWorkspaceAttachedRepo['source']>([
  'detected-checkout',
  'first-worktree',
  'manual'
])

function normalizeAttachment(raw: unknown): FolderWorkspaceAttachedRepo | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const entry = raw as Record<string, unknown>
  const strings = ['key', 'gitIdentity', 'hostId', 'repoId', 'repoPath', 'displayName'] as const
  if (strings.some((field) => typeof entry[field] !== 'string' || entry[field] === '')) {
    return null
  }
  // Why: rows written before path normalization must still match a re-registered checkout.
  const gitIdentity = (entry.gitIdentity as string).startsWith('path:')
    ? `path:${normalizeRuntimePathForComparison((entry.gitIdentity as string).slice(5))}`
    : (entry.gitIdentity as string)
  return {
    key: `${entry.hostId as string}|${gitIdentity}`,
    gitIdentity,
    hostId: entry.hostId as ExecutionHostId,
    repoId: entry.repoId as string,
    repoPath: entry.repoPath as string,
    displayName: entry.displayName as string,
    source: SOURCES.has(entry.source as FolderWorkspaceAttachedRepo['source'])
      ? (entry.source as FolderWorkspaceAttachedRepo['source'])
      : 'manual',
    attachedAt:
      typeof entry.attachedAt === 'number' && Number.isFinite(entry.attachedAt)
        ? entry.attachedAt
        : 0
  }
}

/** Persisted JSON is untrusted: drop malformed rows and duplicate keys rather than fail the load. */
export function normalizeFolderWorkspaceAttachedRepos(
  raw: unknown
): FolderWorkspaceAttachedReposById {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const result: FolderWorkspaceAttachedReposById = {}
  for (const [folderWorkspaceId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue
    }
    const attachments = dedupeAttachedReposByKey(
      list.map(normalizeAttachment).filter((entry): entry is FolderWorkspaceAttachedRepo => !!entry)
    )
    if (attachments.length > 0) {
      result[folderWorkspaceId] = attachments
    }
  }
  return result
}

/**
 * Picks the repo for `omni worktree create` in a folder workspace. With a name, match an
 * attached repo by display name or identity tail; without one, the only attached repo.
 */
export function selectAttachedRepoForCreate(
  attachments: readonly FolderWorkspaceAttachedRepo[],
  name: string | undefined
):
  | { kind: 'match'; attachment: FolderWorkspaceAttachedRepo }
  | { kind: 'none-attached' }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'no-match' } {
  if (attachments.length === 0) {
    return { kind: 'none-attached' }
  }
  if (!name) {
    return attachments.length === 1
      ? { kind: 'match', attachment: attachments[0] }
      : { kind: 'ambiguous', names: attachments.map((entry) => entry.displayName) }
  }
  const wanted = name.trim().toLowerCase()
  const matches = attachments.filter(
    (entry) =>
      entry.displayName.toLowerCase() === wanted ||
      entry.gitIdentity === wanted ||
      entry.gitIdentity.split('/').at(-1) === wanted
  )
  if (matches.length === 1) {
    return { kind: 'match', attachment: matches[0] }
  }
  return matches.length > 1
    ? { kind: 'ambiguous', names: matches.map((entry) => `${entry.displayName} (${entry.hostId})`) }
    : { kind: 'no-match' }
}
