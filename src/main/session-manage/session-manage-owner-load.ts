// Whether a live session can take a new task now (`sessionOwnerLoad`, re-checked by
// `session assign`), and whether `session find-owner` may consider it at all.

import type { SessionManageEntry } from '../../shared/session-manage-types'
import type {
  SessionFindOwnerResult,
  SessionOwnerCandidate,
  SessionOwnerSignal
} from '../../shared/session-owner-types'
import { remoteExecutionRefusal } from './session-manage-locality'
import type { SessionOwnerDeps, SessionOwnerObserved } from './session-manage-owner'
import { sessionOwnerOverlap } from './session-manage-owner-files'
import type { SessionOwnerJudgement } from './session-manage-owner-jev'
import { isConflictOwner } from './session-manage-owner-decide'

const SIGNAL_WEIGHT: Record<SessionOwnerSignal, number> = {
  'file-conflict': 16,
  'target-worktree': 8,
  'same-worktree': 4,
  'same-folder': 3,
  'transcript-match': 2,
  'same-repo': 1
}

export type SessionOwnerConsidered = SessionOwnerObserved & {
  signals: SessionOwnerSignal[]
  conflictFiles: string[]
  load: { light: boolean; words: string }
  summary: string | null
  judgeable: boolean
}

export const sessionOwnerSignalStrength = (signals: readonly SessionOwnerSignal[]): number =>
  signals.reduce((sum, signal) => sum + SIGNAL_WEIGHT[signal], 0)

export function compareSessionOwners(
  left: SessionOwnerCandidate,
  right: SessionOwnerCandidate
): number {
  return (
    Number(isConflictOwner(right)) - Number(isConflictOwner(left)) ||
    (right.related ?? -1) - (left.related ?? -1) ||
    sessionOwnerSignalStrength(right.signals) - sessionOwnerSignalStrength(left.signals)
  )
}

export function compareConsideredSessionOwners(
  left: SessionOwnerConsidered,
  right: SessionOwnerConsidered
): number {
  return (
    sessionOwnerSignalStrength(right.signals.filter((signal) => SIGNAL_WEIGHT[signal] >= 8)) -
      sessionOwnerSignalStrength(left.signals.filter((signal) => SIGNAL_WEIGHT[signal] >= 8)) ||
    Number(left.load.light) - Number(right.load.light) ||
    sessionOwnerSignalStrength(right.signals) - sessionOwnerSignalStrength(left.signals) ||
    (right.entry.lastActivityAt ?? 0) - (left.entry.lastActivityAt ?? 0)
  )
}

export function sessionOwnerCandidate(
  { entry, signals, load, conflictFiles }: SessionOwnerConsidered,
  judgement: SessionOwnerJudgement | null,
  goal: string | null
): SessionOwnerCandidate {
  return {
    paneKey: entry.paneKey!,
    tabId: entry.tabId,
    title: entry.title,
    folder: entry.folder,
    worktreePath: entry.worktreePath,
    state: entry.state,
    light: load.light,
    load: load.words,
    signals,
    conflictFiles,
    related: judgement?.related ?? null,
    duplicate: judgement?.duplicate ?? null,
    goal
  }
}

/** Common unchecked evidence shape, with a structured risk bit for unresolved file overlap. */
export function sessionOwnerUncheckedEvidence(
  { entry }: Pick<SessionOwnerObserved, 'entry'>,
  reason: string,
  input: {
    taskFiles: readonly string[]
    scopeSignals?: readonly SessionOwnerSignal[]
    reservedSibling?: boolean
    requestingPane?: boolean
  }
): SessionFindOwnerResult['unchecked'][number] {
  const possibleFileConflict =
    input.taskFiles.length > 0 &&
    ((input.scopeSignals?.length ?? 0) > 0 || input.reservedSibling) &&
    !input.requestingPane
  return {
    paneKey: entry.paneKey,
    title: entry.title,
    reason,
    ...(possibleFileConflict ? { risk: 'possible-file-conflict' as const } : {})
  }
}

const BUSY_WORDS: Partial<Record<SessionManageEntry['state'], string>> = {
  working: 'working',
  queued: 'it has prompts waiting in its queue',
  'provider-limited': 'a provider usage limit holds it',
  'awaiting-user': 'it is waiting on the person',
  'waiting-for-yes': 'it is waiting for a yes to its own proposal',
  exited: 'exited',
  unknown: 'its state is unknown'
}

/** Free for a new task, or the plain reason it is not. Rechecked by `session assign`. */
export function sessionOwnerLoad(
  entry: SessionManageEntry,
  bound: boolean
): { light: boolean; words: string } {
  const busy = (words: string) => ({ light: false, words })
  if (entry.state !== 'idle') {
    return busy(BUSY_WORDS[entry.state] ?? entry.state)
  }
  if (entry.queueLength > 0) {
    return busy('it has prompts waiting in its queue')
  }
  if (entry.pendingSteps.length > 0) {
    return busy('it has open next steps of its own')
  }
  if (entry.waitingOn || entry.ask) {
    return busy(`it is waiting on the person${entry.waitingOn ? ` (${entry.waitingOn})` : ''}`)
  }
  if (entry.keepGoing) {
    return busy('Keep going drives it')
  }
  if (bound) {
    return busy('an outcome run or session chain drives it')
  }
  if (entry.kind === 'terminal' && entry.agentForeground !== true) {
    return busy('its agent could not be proven to hold its terminal')
  }
  return { light: true, words: 'idle, nothing queued or pending' }
}

export type SessionOwnerEligibility = { eligible: true } | { eligible: false; unchecked?: string }

/** Only live sessions this computer executes can take a task; unverifiable ones are unchecked. */
export function sessionOwnerEligibility(
  { row, entry }: Pick<SessionOwnerObserved, 'row' | 'entry'>,
  exclude: ReadonlySet<string>
): SessionOwnerEligibility {
  if (row.folded || row.routine || entry.archived || row.launchPending || !entry.paneKey) {
    return { eligible: false }
  }
  if (exclude.has(entry.paneKey) || remoteExecutionRefusal(entry, 'assign')) {
    return { eligible: false }
  }
  if (row.hostUnavailable || entry.verdict === 'unverifiable') {
    return { eligible: false, unchecked: 'its host cannot be reached' }
  }
  if (entry.state === 'unknown') {
    return { eligible: false, unchecked: 'its state is unknown' }
  }
  // Why awaiting-user stays: it may hold the task's files or be doing it; it is never light.
  if (entry.verdict === 'exited') {
    return { eligible: false }
  }
  return { eligible: true }
}

/** Excluded local panes stay visible to file-conflict checks, without becoming reuse candidates. */
export function sessionOwnerExcludedConflictReadable(
  { row, entry }: Pick<SessionOwnerObserved, 'row' | 'entry'>,
  exclude: ReadonlySet<string>
): boolean {
  return (
    !!entry.paneKey &&
    exclude.has(entry.paneKey) &&
    !entry.archived &&
    !row.hostUnavailable &&
    entry.verdict !== 'unverifiable' &&
    entry.verdict !== 'exited' &&
    !remoteExecutionRefusal(entry, 'assign')
  )
}

export function sessionOwnerExcludedConflictUnknown(
  { row, entry }: Pick<SessionOwnerObserved, 'row' | 'entry'>,
  exclude: ReadonlySet<string>
): boolean {
  return (
    exclude.has(entry.paneKey ?? '') &&
    (!!remoteExecutionRefusal(entry, 'assign') ||
      row.hostUnavailable ||
      entry.verdict === 'unverifiable')
  )
}

export async function readSessionOwnerConflicts(
  taskFiles: readonly string[],
  observed: readonly SessionOwnerObserved[],
  deps: SessionOwnerDeps
): Promise<{ overlap: (entry: SessionOwnerObserved) => string[]; unreadable: Set<string> }> {
  if (taskFiles.length === 0 || observed.length === 0) {
    return { overlap: () => [], unreadable: new Set() }
  }
  const read = await deps.changes(observed.map(({ row, entry }) => ({ row, entry })))
  const changed = new Map(read.changes.map((change) => [change.worktreeId, change.files]))
  return {
    overlap: ({ row }) =>
      sessionOwnerOverlap(taskFiles, changed.get(row.worktreeId) ?? [], row.worktreePath),
    unreadable: new Set(read.unreadable)
  }
}
