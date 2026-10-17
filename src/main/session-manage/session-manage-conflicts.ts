/**
 * `omni session conflicts`: live sessions of one repo that are changing the same files. Git runs
 * on each worktree's own execution host (through the runtime, so SSH and WSL worktrees are read
 * where they live); a host that cannot be read is reported, never guessed, and a folder workspace
 * has no git, so it has nothing git could compare.
 */

import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type {
  SessionConflictsResult,
  SessionConflictSession,
  SessionConflictWorktree,
  SessionManageEntry
} from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'

const STATUS_CONCURRENCY = 4
const MAX_FILES_PER_WORKTREE = 500

export type LiveSession = { entry: SessionManageEntry; row: SessionManageSidebarRow }

/** Changed paths relative to the worktree root; throws when git could not be read. */
export type ReadChangedFiles = (
  worktreeId: string
) => Promise<{ files: string[]; branch: string | null }>

type WorktreeChanges = SessionConflictWorktree & { repo: string; files: string[] }

function sessionOf(entry: SessionManageEntry): SessionConflictSession {
  return { paneKey: entry.paneKey, title: entry.title }
}

function byWorktree(sessions: readonly LiveSession[]): Map<string, LiveSession[]> {
  const groups = new Map<string, LiveSession[]>()
  for (const session of sessions) {
    const group = groups.get(session.row.worktreeId) ?? []
    group.push(session)
    groups.set(session.row.worktreeId, group)
  }
  return groups
}

function skipReason(row: SessionManageSidebarRow): string | null {
  if (row.workspaceKind === 'folder') {
    return 'A folder workspace has no git, so there are no git conflicts to compare.'
  }
  if (row.workspaceKind === 'unknown' || !row.repoId) {
    return 'The window does not know which repository this workspace belongs to.'
  }
  return null
}

/** Sharing one workspace is a conflict whether or not git can read it. */
function withSharing(reason: string, sessions: readonly LiveSession[]): string {
  return sessions.length > 1
    ? `${reason} ${sessions.length} live sessions share this one workspace.`
    : reason
}

export type SessionWorktreeChanges = {
  changes: (WorktreeChanges & { repoId: string })[]
  skipped: SessionConflictsResult['skipped']
  /** Worktrees whose git could not be read: unverifiable, never clean. */
  unreadable: string[]
  checkedWorktrees: number
}

/**
 * What each live session's worktree has changed (git working tree, on its own host), grouped by
 * worktree: the evidence `session conflicts` and `session find-owner` both read.
 */
export async function readSessionWorktreeChanges(
  live: readonly LiveSession[],
  readChanged: ReadChangedFiles
): Promise<SessionWorktreeChanges> {
  const skipped: SessionConflictsResult['skipped'] = []
  const checkable: { worktreeId: string; sessions: LiveSession[] }[] = []
  const unreadable: string[] = []
  for (const [worktreeId, sessions] of byWorktree(live)) {
    const row = sessions[0]!.row
    const reason = skipReason(row)
    if (reason) {
      skipped.push({
        worktreeId,
        path: row.worktreePath,
        reason: withSharing(reason, sessions),
        sessions: sessions.map((session) => session.entry.title)
      })
    } else {
      checkable.push({ worktreeId, sessions })
    }
  }
  const changes = await mapWithConcurrency(checkable, STATUS_CONCURRENCY, async (group) => {
    const row = group.sessions[0]!.row
    try {
      const read = await readChanged(group.worktreeId)
      return {
        repo: row.repoLabel ?? row.repoId!,
        repoId: row.repoId!,
        worktreeId: group.worktreeId,
        path: row.worktreePath,
        branch: read.branch ?? row.branch,
        sessions: group.sessions.map((session) => sessionOf(session.entry)),
        files: [...new Set(read.files)]
          .sort((left, right) => left.localeCompare(right))
          .slice(0, MAX_FILES_PER_WORKTREE)
      }
    } catch (error) {
      unreadable.push(group.worktreeId)
      skipped.push({
        worktreeId: group.worktreeId,
        path: row.worktreePath,
        reason: withSharing(
          `Git status could not be read on its host (${error instanceof Error ? error.message : String(error)}); unverifiable, not clean.`,
          group.sessions
        ),
        sessions: group.sessions.map((session) => session.entry.title)
      })
      return null
    }
  })
  return {
    changes: changes.filter((change) => change !== null),
    skipped,
    unreadable,
    checkedWorktrees: checkable.length
  }
}

export async function findSessionConflicts(
  live: readonly LiveSession[],
  readChanged: ReadChangedFiles
): Promise<SessionConflictsResult> {
  const { changes, skipped, checkedWorktrees } = await readSessionWorktreeChanges(live, readChanged)
  const repos = new Map<string, { repo: string; worktrees: WorktreeChanges[] }>()
  for (const change of changes) {
    const repo = repos.get(change.repoId) ?? { repo: change.repo, worktrees: [] }
    const { repoId: _repoId, ...worktree } = change
    repo.worktrees.push(worktree)
    repos.set(change.repoId, repo)
  }
  return {
    repos: [...repos.values()]
      .map(({ repo, worktrees }) => repoConflicts(repo, worktrees))
      .filter((repo) => repo.sharedFiles.length > 0 || repo.sharedWorktrees.length > 0),
    skipped,
    checkedWorktrees
  }
}

function repoConflicts(
  repo: string,
  worktrees: readonly WorktreeChanges[]
): SessionConflictsResult['repos'][number] {
  const holders = new Map<string, WorktreeChanges[]>()
  for (const worktree of worktrees) {
    for (const file of worktree.files) {
      holders.set(file, [...(holders.get(file) ?? []), worktree])
    }
  }
  const strip = ({
    files: _files,
    repo: _repo,
    ...rest
  }: WorktreeChanges): SessionConflictWorktree => rest
  return {
    repo,
    sharedFiles: [...holders.entries()]
      .filter(([, holding]) => holding.length > 1)
      .map(([path, holding]) => ({ path, worktrees: holding.map(strip) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    sharedWorktrees: worktrees
      .filter((worktree) => worktree.sessions.length > 1)
      .map(({ repo: _repo, ...rest }) => rest)
  }
}
