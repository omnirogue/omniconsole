/**
 * `session find-owner`'s decision table over the judged candidates, strongest first:
 * duplicate → don't launch (ask the owner; assign when it is idle) · file-conflict owner idle →
 * assign · file-conflict owner busy → conflict-owner-busy, no parallel editor · related and light
 * → assign · related and busy → launch new · unrelated → launch new · unchecked → say so.
 * Launch dispositions recommend `omni session launch`, the one launcher that verifies an account.
 */

import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import {
  SESSION_OWNER_RELATED_MIN,
  type SessionFindOwnerResult,
  type SessionOwnerCandidate,
  type SessionOwnerSignal
} from '../../shared/session-owner-types'

export type SessionOwnerDecision = Pick<
  SessionFindOwnerResult,
  'disposition' | 'launchNew' | 'reason' | 'recommend' | 'owner'
>

const SIGNAL_WORDS: Record<SessionOwnerSignal, string> = {
  'file-conflict': 'editing files this task names',
  'target-worktree': 'working in the workspace this task targets',
  'same-worktree': 'same workspace',
  'same-folder': 'same folder',
  'same-repo': 'same repository',
  'transcript-match': 'its transcript matches the task'
}

const describeSignals = (candidate: SessionOwnerCandidate): string =>
  candidate.signals
    .map((signal) =>
      signal === 'file-conflict' && candidate.conflictFiles.length
        ? `${SIGNAL_WORDS[signal]}: ${candidate.conflictFiles.slice(0, 5).join(', ')}${candidate.conflictFiles.length > 5 ? ', …' : ''}`
        : SIGNAL_WORDS[signal]
    )
    .join('; ')

export const isConflictOwner = (candidate: SessionOwnerCandidate): boolean =>
  candidate.signals.includes('file-conflict') || candidate.signals.includes('target-worktree')

const atLeast = (score: number | null): boolean =>
  score !== null && score >= SESSION_OWNER_RELATED_MIN

const assignCommand = (owner: SessionOwnerCandidate): string =>
  `omni session assign --pane ${owner.paneKey} --task "<the task>" --reason "<why this session>"`

const askCommand = (owner: SessionOwnerCandidate): string =>
  `omni session ask --pane ${owner.paneKey} --question "<does your current work already cover this task, and what is left?>"`

/**
 * Where a launch disposition's new session would run: a named workspace fixes the computer; else a
 * project other computers share lets the launch pick one; unset means the caller's own workspace.
 */
export type SessionOwnerLaunchTarget = { worktreeId?: string | null; projectId?: string | null }

const shellWord = (value: string): string =>
  /^[\w.:/@-]+$/.test(value) ? value : quotePosixShell(value)

// Why placeholders: find-owner knows where the task runs, not which agent or brief the caller has.
const launchCommand = (target: SessionOwnerLaunchTarget | undefined): string => {
  const head = 'omni session launch --provider <claude|codex>'
  const brief = '--prompt-file <brief.md>'
  if (target?.worktreeId) {
    return `${head} ${brief} --worktree ${shellWord(`id:${target.worktreeId}`)} --json`
  }
  // Why: with a shared project the launch picks the computer with the most verified capacity.
  return target?.projectId
    ? `${head} --project ${shellWord(target.projectId)} ${brief} --json`
    : `${head} ${brief} --json`
}

export function decideSessionOwner(input: {
  candidates: readonly SessionOwnerCandidate[]
  judged: number
  failures: readonly string[]
  gaps: readonly string[]
  launchTarget?: SessionOwnerLaunchTarget
}): SessionOwnerDecision {
  const { candidates } = input
  const launchRecommend = launchCommand(input.launchTarget)
  const duplicate = candidates
    .filter((candidate) => atLeast(candidate.duplicate))
    .sort(
      (left, right) =>
        Number(right.light) - Number(left.light) || (right.duplicate ?? 0) - (left.duplicate ?? 0)
    )[0]
  if (duplicate) {
    const name = `“${duplicate.title}”`
    return {
      disposition: 'duplicate',
      launchNew: false,
      owner: duplicate,
      reason: duplicate.light
        ? `${name} is already doing this same work and is idle: don't launch a new session; give it the task if it still needs doing.`
        : `${name} is already doing this same work (${duplicate.load}): don't launch a new session; ask it where it stands.`,
      recommend: duplicate.light ? assignCommand(duplicate) : askCommand(duplicate)
    }
  }
  const conflicts = candidates.filter(isConflictOwner)
  const freeConflict = conflicts.find((candidate) => candidate.light)
  if (freeConflict) {
    return {
      disposition: 'assign',
      launchNew: false,
      owner: freeConflict,
      reason: `“${freeConflict.title}” is idle and ${describeSignals(freeConflict)}: give it the task; a second session would edit the same files.`,
      recommend: assignCommand(freeConflict)
    }
  }
  const busyConflict = conflicts[0]
  if (busyConflict) {
    return {
      disposition: 'conflict-owner-busy',
      launchNew: false,
      owner: busyConflict,
      reason: `“${busyConflict.title}” is ${describeSignals(busyConflict)} and is busy (${busyConflict.load}): don't launch a parallel editor; wait until it is free, or ask it.`,
      recommend: askCommand(busyConflict)
    }
  }
  const related = candidates.filter((candidate) => atLeast(candidate.related))
  const free = related.find((candidate) => candidate.light)
  if (free) {
    return {
      disposition: 'assign',
      launchNew: false,
      owner: free,
      reason: `“${free.title}” is idle and this task continues its work (${describeSignals(free)}): give it the task instead of launching a new session.`,
      recommend: assignCommand(free)
    }
  }
  const busy = related[0]
  if (busy) {
    return {
      disposition: 'busy-related',
      launchNew: true,
      owner: busy,
      reason: `“${busy.title}” does related work but is busy (${busy.load}) and edits none of this task's files: launch a new session (parallel work is efficient) and mention it.`,
      recommend: launchRecommend
    }
  }
  if (input.judged > 0 && input.failures.length === input.judged) {
    return {
      disposition: 'launch-new',
      launchNew: true,
      reason: `JEV could not judge whether a session is doing this task (${input.failures[0]}), so none is treated as related: launch a new session.`,
      recommend: launchRecommend
    }
  }
  if (input.gaps.length > 0) {
    return {
      disposition: 'coverage-incomplete',
      launchNew: true,
      reason: `No checked session is doing this task, but ${input.gaps.join(' and ')}: launch a new session, and say so.`,
      recommend: launchRecommend
    }
  }
  return {
    disposition: 'launch-new',
    launchNew: true,
    reason:
      input.judged > 0
        ? `None of the ${input.judged} session(s) sharing its place or topic is doing this task: launch a new session.`
        : 'No live session on this computer shares this task’s files, workspace, folder, repository or transcript topic: launch a new session.',
    recommend: launchRecommend
  }
}
