/**
 * `omni session find-owner`: before launching a new session for a task, find a live session on
 * this computer already doing it, editing the files it names, or doing related work with room for
 * it. Evidence: the uncommitted changes `session conflicts` reads, the session's place (workspace,
 * folder, repository), a transcript hit, and JEV on the session's goal (`-owner-jev.ts`); the
 * decision table is `-owner-decide.ts`. Read-only: it never sends anything.
 */

import {
  getProjectIdentityKey,
  isHostLocalProjectId
} from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionSearchHit } from '../../shared/session-search-types'
import {
  SESSION_OWNER_MAX_JUDGED,
  type SessionFindOwnerResult,
  type SessionOwnerSignal
} from '../../shared/session-owner-types'
import type { LiveSession, SessionWorktreeChanges } from './session-manage-conflicts'
import { decideSessionOwner } from './session-manage-owner-decide'
import { sessionOwnerTaskFiles } from './session-manage-owner-files'
import {
  sessionOwnerEligibility,
  sessionOwnerExcludedConflictReadable,
  sessionOwnerExcludedConflictUnknown,
  sessionOwnerLoad,
  readSessionOwnerConflicts,
  sessionOwnerUncheckedEvidence,
  compareConsideredSessionOwners,
  compareSessionOwners,
  sessionOwnerCandidate,
  type SessionOwnerConsidered
} from './session-manage-owner-load'
import type { SessionOwnerJudgement } from './session-manage-owner-jev'

/** Where the new task would run; each set field is a place a related session may share. */
export type SessionOwnerScope = {
  worktreeId?: string | null
  folderId?: string | null
  repoId?: string | null
  /** The existing workspace the task would run in; a session working there is a conflict owner. */
  targetWorktreeId?: string | null
  /** `repoId`'s project identity when other computers can share it (`sessionOwnerProjectId`). */
  projectId?: string | null
}

/** A repo's cross-host project identity; null for a `repo:` id no other computer can match. */
export function sessionOwnerProjectId(
  repo: Pick<Repo, 'id' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'> | undefined
): string | null {
  const key = repo ? getProjectIdentityKey(repo) : null
  return key && !isHostLocalProjectId(key) ? key : null
}

export type SessionOwnerObserved = {
  row: SessionManageSidebarRow
  entry: SessionManageEntry
  /** An unfinished session chain or outcome run owns its turns (`isChainBoundToConversation`). */
  bound: boolean
}

/** A local transcript hit joined to a live sidebar row. */
export type SessionOwnerTranscriptMatch = { summary: string | null }

export type SessionOwnerDeps = {
  /** Local transcript hits for the task, by pane key; `searched: false` when search could not run. */
  search(task: string): Promise<{
    matches: ReadonlyMap<string, SessionOwnerTranscriptMatch>
    searched: boolean
    note?: string
    /** The local hits themselves, for past work (`session-manage-owner-past.ts`). */
    hits?: readonly SessionSearchHit[]
  }>
  /** The session's goal line (its first genuine prompt), or null when it cannot be read. */
  goal(row: SessionManageSidebarRow): Promise<string | null>
  /** JEV on continuation and same-deliverable (both orders), or why it could not judge. */
  judge(
    task: string,
    session: { title: string; goal: string | null; summary: string | null }
  ): Promise<SessionOwnerJudgement | { failed: string }>
  /** Uncommitted changes of these sessions' worktrees (`readSessionWorktreeChanges`). */
  changes(live: readonly LiveSession[]): Promise<SessionWorktreeChanges>
}

export function sessionOwnerSignals(
  row: SessionManageSidebarRow,
  scope: SessionOwnerScope,
  evidence: { transcriptMatch: boolean; conflictFiles: readonly string[] }
): SessionOwnerSignal[] {
  const signals: SessionOwnerSignal[] = []
  if (evidence.conflictFiles.length > 0) {
    signals.push('file-conflict')
  }
  if (scope.targetWorktreeId && row.worktreeId === scope.targetWorktreeId) {
    // Why: a folder workspace (no git) holds many unrelated sessions and no file overlap can be
    // read there, so sharing it is a place, not a conflict; JEV decides whether it is related.
    signals.push(row.workspaceKind === 'folder' ? 'same-worktree' : 'target-worktree')
  } else if (scope.worktreeId && row.worktreeId === scope.worktreeId) {
    signals.push('same-worktree')
  }
  if (scope.folderId && row.folderId === scope.folderId) {
    signals.push('same-folder')
  }
  if (evidence.transcriptMatch) {
    signals.push('transcript-match')
  }
  const sameWorktree = signals.includes('same-worktree') || signals.includes('target-worktree')
  if (scope.repoId && row.repoId === scope.repoId && !sameWorktree) {
    signals.push('same-repo')
  }
  return signals
}

export async function findSessionOwner(
  input: {
    task: string
    /** Files the caller names besides those in the task text (`--files`). */
    files?: readonly string[]
    scope: SessionOwnerScope
    observed: readonly SessionOwnerObserved[]
    /** Never offered: the asking session, or owners already offered other items of a batch. */
    exclude?: ReadonlySet<string>
    /** Excluded sibling owners whose file conflicts remain visible; omits the asking session. */
    conflictExclude?: ReadonlySet<string>
  },
  deps: SessionOwnerDeps
): Promise<SessionFindOwnerResult> {
  const exclude = input.exclude ?? new Set<string>()
  const conflictExclude = input.conflictExclude ?? new Set<string>()
  const taskFiles = sessionOwnerTaskFiles(input.task, input.files)
  const search = await deps.search(input.task)
  const unchecked: SessionFindOwnerResult['unchecked'] = []
  const eligible: SessionOwnerObserved[] = []
  const excludedForConflictRead: SessionOwnerObserved[] = []
  for (const observed of input.observed) {
    const verdict = sessionOwnerEligibility(observed, exclude)
    if (verdict.eligible) {
      eligible.push(observed)
      continue
    }
    // Why: an explicit reuse exclusion prevents an offer, but cannot hide a live file conflict.
    if (sessionOwnerExcludedConflictReadable(observed, conflictExclude)) {
      excludedForConflictRead.push(observed)
    }
    const scopeSignals = sessionOwnerSignals(observed.row, input.scope, {
      transcriptMatch: search.matches.has(observed.entry.paneKey ?? ''),
      conflictFiles: []
    })
    const shares = taskFiles.length > 0 || scopeSignals.length > 0
    const paneKey = observed.entry.paneKey ?? ''
    const sourceExcludedFromConflictRead = exclude.has(paneKey) && !conflictExclude.has(paneKey)
    if (verdict.unchecked && shares) {
      unchecked.push(
        sessionOwnerUncheckedEvidence(observed, verdict.unchecked, {
          taskFiles,
          scopeSignals,
          reservedSibling: conflictExclude.has(paneKey),
          requestingPane: sourceExcludedFromConflictRead
        })
      )
    } else if (sessionOwnerExcludedConflictUnknown(observed, conflictExclude) && shares) {
      unchecked.push(
        sessionOwnerUncheckedEvidence(
          observed,
          'excluded session file overlap is unknown because its execution host cannot be inspected',
          { taskFiles, scopeSignals, reservedSibling: conflictExclude.has(paneKey) }
        )
      )
    }
  }
  const conflicts = await readSessionOwnerConflicts(
    taskFiles,
    [...eligible, ...excludedForConflictRead],
    deps
  )
  const considered: SessionOwnerConsidered[] = []
  for (const observed of eligible) {
    const match = search.matches.get(observed.entry.paneKey!)
    const conflictFiles = conflicts.overlap(observed)
    const signals = sessionOwnerSignals(observed.row, input.scope, {
      transcriptMatch: match !== undefined,
      conflictFiles
    })
    if (conflicts.unreadable.has(observed.row.worktreeId)) {
      unchecked.push(
        sessionOwnerUncheckedEvidence(
          observed,
          'its workspace’s git status could not be read, so file overlap is unknown',
          { taskFiles, scopeSignals: signals }
        )
      )
    }
    if (signals.length > 0) {
      considered.push({
        ...observed,
        signals,
        conflictFiles,
        load: sessionOwnerLoad(observed.entry, observed.bound),
        summary: match?.summary ?? null,
        judgeable: true
      })
    }
  }
  for (const observed of excludedForConflictRead) {
    if (conflicts.unreadable.has(observed.row.worktreeId)) {
      unchecked.push(
        sessionOwnerUncheckedEvidence(
          observed,
          'its workspace’s git status could not be read, so file overlap is unknown',
          { taskFiles, reservedSibling: true }
        )
      )
      continue
    }
    const conflictFiles = conflicts.overlap(observed)
    if (conflictFiles.length > 0) {
      considered.push({
        ...observed,
        signals: ['file-conflict'],
        conflictFiles,
        load: { light: false, words: 'reserved for another session-prep item' },
        summary: null,
        judgeable: false
      })
    }
  }
  // Why conflict owners, then free ones first: the JEV budget goes where the decision turns.
  considered.sort(compareConsideredSessionOwners)
  const judgeable = considered.filter((entry) => entry.judgeable)
  const judged = judgeable.slice(0, SESSION_OWNER_MAX_JUDGED)
  const failures: string[] = []
  const candidates = await Promise.all(
    judged.map(async (entry) => {
      const goal = await deps.goal(entry.row).catch(() => null)
      const judgement = await deps
        .judge(input.task, { title: entry.entry.title, goal, summary: entry.summary })
        .catch((error: unknown) => ({
          failed: error instanceof Error ? error.message : String(error)
        }))
      if ('failed' in judgement) {
        failures.push(judgement.failed)
        return sessionOwnerCandidate(entry, null, goal)
      }
      return sessionOwnerCandidate(entry, judgement, goal)
    })
  )
  for (const entry of [
    ...considered.filter((candidate) => !candidate.judgeable),
    ...judgeable.slice(SESSION_OWNER_MAX_JUDGED)
  ]) {
    if (entry.judgeable) {
      unchecked.push({
        paneKey: entry.entry.paneKey,
        title: entry.entry.title,
        reason: `not judged because the session-owner limit is ${SESSION_OWNER_MAX_JUDGED}`
      })
    }
    candidates.push(sessionOwnerCandidate(entry, null, null))
  }
  candidates.sort(compareSessionOwners)
  const gaps = [
    ...(unchecked.length > 0 ? [`${unchecked.length} session(s) could not be checked`] : []),
    ...(!search.searched
      ? [`transcripts were not searched${search.note ? ` (${search.note})` : ''}`]
      : [])
  ]
  return {
    ...decideSessionOwner({
      candidates,
      judged: judged.length,
      failures,
      gaps,
      launchTarget: {
        worktreeId: input.scope.targetWorktreeId,
        projectId: input.scope.projectId
      }
    }),
    taskFiles,
    candidates,
    unchecked,
    ...(failures.length > 0 ? { jevError: failures[0] } : {})
  }
}
