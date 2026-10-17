/**
 * `omni session find-owner` / `session assign`: before launching a new session for a task, look
 * for a live session on this computer already doing it, editing the same files, or doing related
 * work with room for it (Sal, 2026-09-25: "if there are conflicting files its the strongest idea,
 * or if its a duplicate task").
 */

import type { SessionManageState } from './session-manage-types'

/** Related (or duplicate) at or above this JEV P(yes); anything lower, or unsure, is not. */
export const SESSION_OWNER_RELATED_MIN = 0.8
/** Candidates sent to JEV per request; the rest are ranked out by their shared context. */
export const SESSION_OWNER_MAX_JUDGED = 5
export const SESSION_OWNER_TASK_MAX_CHARS = 30_000
export const SESSION_OWNER_MAX_FILES = 50

/**
 * The decision table, strongest first:
 * `duplicate`: `owner` is already doing this same deliverable; don't launch (ask it, or assign
 * when it is idle). `assign`: `owner` is free and either edits the files the task names, works in
 * its target workspace, or does related work; give it the task. `conflict-owner-busy`: `owner` is
 * busy editing those files; don't launch a parallel editor (wait, or ask it). `busy-related`:
 * `owner` is related but busy with no file overlap; launch new (parallel work is efficient).
 * `launch-new`: nothing related (see `reason`). `coverage-incomplete`: nothing found, but some
 * sessions could not be checked (`unchecked`).
 */
export type SessionOwnerDisposition =
  | 'duplicate'
  | 'assign'
  | 'conflict-owner-busy'
  | 'busy-related'
  | 'launch-new'
  | 'coverage-incomplete'
  /** Past work: a finished conversation already delivered it; point to its output. */
  | 'reuse-output'
  /** Past work: a closed or exited conversation this continues; resume it and give it the task. */
  | 'resume'
  /** Past work: an archived conversation this continues; unarchive it and give it the task. */
  | 'unarchive-and-continue'

/**
 * What ties a session to the task: `file-conflict` (its worktree has uncommitted changes to files
 * the task names) and `target-worktree` (it works in the workspace the task targets) are the
 * strongest; then its place (workspace, folder, repository) or topic (a transcript hit).
 */
export type SessionOwnerSignal =
  | 'file-conflict'
  | 'target-worktree'
  | 'same-worktree'
  | 'same-folder'
  | 'same-repo'
  | 'transcript-match'

export type SessionOwnerCandidate = {
  paneKey: string
  tabId: string | null
  title: string
  folder: string | null
  worktreePath: string | null
  state: SessionManageState
  /** Idle with nothing queued, pending, waiting on the person or driving it. */
  light: boolean
  /** Plain words: why it is (or is not) free. */
  load: string
  signals: SessionOwnerSignal[]
  /** Its worktree's uncommitted changes that the task's files cover (relative paths). */
  conflictFiles: string[]
  /** JEV's P(yes) that the task continues this session's goal; null when it was not judged. */
  related: number | null
  /** JEV's P(yes), the lower of both orders, that the task is the same deliverable; null when not judged. */
  duplicate: number | null
  /** The session's goal line JEV judged against, when one was read. */
  goal: string | null
}

/** Where a past conversation is now: under Archived, exited in its row, or its tab closed. */
export type SessionOwnerPastKind = 'archived' | 'exited' | 'closed'

/** A conversation from `session search` that no live session holds, judged against the task. */
export type SessionOwnerPastCandidate = {
  /** `<agent>:<id>@local`, for `session assign --ref` and `session resume --ref`. */
  ref: string
  kind: SessionOwnerPastKind
  title: string
  /** The sidebar row holding it (archived or exited); null when its tab was closed. */
  paneKey: string | null
  archiveKind: 'manual' | 'automatic' | null
  cwd: string | null
  transcriptPath: string
  lastActivityAt: number | null
  /** JEV's P(yes) that the task continues its goal; null when it was not judged. */
  related: number | null
  /** JEV's P(yes), the lower of both orders, that the task is the same deliverable. */
  duplicate: number | null
  /** Its commitment was verified complete (filed by the automatic archive), so its result stands. */
  finished: boolean
  /** Output links it recorded (PRs, published pages), newest first. */
  links: string[]
  goal: string | null
}

export type SessionFindOwnerResult = {
  /** Monotonic elapsed spans; concurrent/nested phases overlap. Absent on older hosts. */
  timing?: {
    totalDurationMs: number
    phases: { phase: string; startedAtMs: number; durationMs: number }[]
  }
  disposition: SessionOwnerDisposition
  /** Whether a new session should be launched for the task. */
  launchNew: boolean
  /** One sentence for the person. */
  reason: string
  /** The next command, when there is one (assign it, ask the owner, or `omni session launch`). */
  recommend?: string
  /** The session the disposition names (all but launch-new and coverage-incomplete). */
  owner?: SessionOwnerCandidate
  /** The paths, file names and globs read from the task (and `--files`). */
  taskFiles: string[]
  /** Every session judged or considered, best first. */
  candidates: SessionOwnerCandidate[]
  /** Sessions that could matter but could not be checked, and why. */
  unchecked: {
    paneKey: string | null
    title: string
    reason: string
    /** Present only when this unchecked session could own task files. */
    risk?: 'possible-file-conflict'
  }[]
  /** Why JEV could not judge, when it could not. */
  jevError?: string
  /** The past conversation a past-work disposition names. */
  pastOwner?: SessionOwnerPastCandidate
  /** Past conversations considered (`session find-owner`; absent from session prep), best first. */
  past?: SessionOwnerPastCandidate[]
}

/** "idle, same folder" — the choice's short why, for the session-prep confirmation. */
export function sessionOwnerShortWhy(
  owner: Pick<SessionOwnerCandidate, 'signals' | 'light'>
): string {
  const place = owner.signals.includes('file-conflict')
    ? 'editing the same files'
    : owner.signals.includes('target-worktree') || owner.signals.includes('same-worktree')
      ? 'same workspace'
      : owner.signals.includes('same-folder')
        ? 'same folder'
        : owner.signals.includes('same-repo')
          ? 'same repository'
          : 'same topic'
  return `${owner.light ? 'idle' : 'busy'}, ${place}`
}
