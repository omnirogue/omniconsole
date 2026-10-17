/**
 * `omni session tidy --delete`: the same plan, deleting instead of archiving. Deleting keeps the
 * history (the tab reopens from Recently closed), so archived rows qualify too. What still has
 * value is kept and says why: working, pinned, saved, a routine's, waiting on the person, open
 * steps, an unfinished recorded commitment, or a state read from its title alone. `--include`
 * lifts the ones a person can judge (not working, not a pending launch). Only sessions this
 * computer runs are deleted: closing another computer's or an SSH host's tab here would stop it
 * there, so those are deleted on the computer that runs them. A session this computer runs but
 * cannot verify goes only with `--unverified`, and never while it was active in the last hour;
 * that delete removes the row and ends no terminal, since what it lists may be a live session
 * shown elsewhere.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  SessionManageEntry,
  SessionManageState,
  SessionTidyGroup
} from '../../shared/session-manage-types'
import type { SessionTidyVerdict } from './session-manage-tidy'

type TidyDeleteRowInput = Pick<
  SessionManageSidebarRow,
  'hostUnavailable' | 'launchPending' | 'routine' | 'strandedMirrorRecord'
>

const STRANDED_MIRROR_RECORD_WHY =
  "Only this computer's saved record of another computer's conversation is left: no computer lists its workspace and this computer cannot name its host."

/** A session this computer cannot verify that was active this recently may still be restoring. */
export const TIDY_DELETE_RECENT_MS = 60 * 60_000

const KEEP_STATE_WORDS: Partial<Record<SessionManageState, string>> = {
  queued: 'It has prompts waiting in its queue.',
  'provider-limited': 'A provider usage limit is holding it.',
  'awaiting-user': 'It is waiting for the person to answer it.',
  'waiting-for-yes': 'It is waiting for a yes to its own proposal.'
}

/** The key `--include` names a row by: its pane, else its tab (a row with no pane yet). */
export function sessionTidyIncludeKey(entry: Pick<SessionManageEntry, 'paneKey' | 'tabId'>) {
  return entry.paneKey ?? entry.tabId
}

/** Why another computer runs it (so it is deleted there), or null when this computer runs it. */
function elsewhere(
  row: TidyDeleteRowInput,
  entry: SessionManageEntry
): { group: SessionTidyGroup; why: string } | null {
  const host = parseExecutionHostId(entry.hostId)
  const there =
    'Closing its tab here would stop it there, so delete it on the computer that runs it.'
  if (host?.kind === 'runtime') {
    return { group: 'other-omniconsole', why: `It runs on another OmniConsole. ${there}` }
  }
  if (host?.kind === 'ssh') {
    return row.hostUnavailable
      ? { group: 'host-disconnected', why: `Its SSH host is not connected. ${there}` }
      : { group: 'ssh-host', why: `It runs on an SSH host. ${there}` }
  }
  return host
    ? null
    : { group: 'unverifiable', why: 'This computer does not know which host runs it.' }
}

/** Why this computer cannot verify a session it runs, or null when it can. */
function unverifiedCase(entry: SessionManageEntry): SessionTidyGroup | null {
  if (!entry.paneKey || entry.verdict === 'unverifiable') {
    return 'unverifiable'
  }
  return entry.state === 'unknown' ? 'unknown-state' : null
}

export function classifySessionTidyDelete(
  row: TidyDeleteRowInput,
  entry: SessionManageEntry,
  hold: string | null,
  include: ReadonlySet<string>,
  options: { unverified: boolean; now: number }
): SessionTidyVerdict {
  const key = sessionTidyIncludeKey(entry)
  const named = key !== null && include.has(key)
  const keep = (group: SessionTidyGroup, reason: string): SessionTidyVerdict =>
    group === 'held' ? { action: 'hold', reason, group } : { action: 'skip', reason, group }
  const remove = (reason: string, extra: Partial<SessionTidyVerdict> = {}): SessionTidyVerdict => ({
    action: 'delete',
    reason: named ? `${reason} The request names it.` : reason,
    ...(named ? { included: true as const } : {}),
    ...extra
  })
  if (row.launchPending) {
    return keep('launch-pending', 'Its launch is still pending.')
  }
  if (entry.state === 'working') {
    return keep(
      'busy',
      'Working. Delete it on its own with omni session delete --force if it should stop.'
    )
  }
  // Why: a stranded record runs nowhere, so no computer could delete it but this one (A4).
  const remote = row.strandedMirrorRecord ? null : elsewhere(row, entry)
  if (remote) {
    return keep(remote.group, remote.why)
  }
  if (entry.pinned && !named) {
    return keep('pinned', 'Pinned.')
  }
  if (entry.saved && !named) {
    return keep('saved', `Saved${entry.folder ? ` (${entry.folder})` : ''}.`)
  }
  if (row.routine && !named) {
    return keep('routine', 'A routine runs in it.')
  }
  const waiting = KEEP_STATE_WORDS[entry.state]
  if (waiting && !named) {
    return keep('busy', waiting)
  }
  if (hold && !named) {
    return keep('held', hold)
  }
  if (row.strandedMirrorRecord) {
    return classifyStrandedMirrorRecord(entry, options, named, keep, remove)
  }
  const unknown = unverifiedCase(entry)
  // Why not waitingOn when unverified: there it says why the state is unknown, not what is open.
  const open = unknown ? null : entry.waitingOn
  if ((open || entry.pendingSteps.length || entry.queueLength) && !named) {
    return keep(
      'open-items',
      `Idle, but it has something open: ${open ?? 'pending steps or queue'}`
    )
  }
  if (unknown) {
    const why = !entry.paneKey
      ? 'It has no terminal pane (a tab left from an earlier run).'
      : entry.verdict === 'unverifiable'
        ? 'No readable terminal is attached on this computer.'
        : 'Its state is unknown.'
    if (!options.unverified) {
      return keep(
        unknown,
        `${why} It cannot be verified, so it is kept; add --unverified to delete it.`
      )
    }
    const recent =
      entry.lastActivityAt !== null && options.now - entry.lastActivityAt < TIDY_DELETE_RECENT_MS
    if (recent && !named) {
      return keep(unknown, `${why} It was active in the last hour and may still be restoring.`)
    }
    return remove(`${why} Deleting removes its row here and ends no terminal; history is kept.`, {
      unverified: true
    })
  }
  // Why not liftable: a delete without --force refuses a state read from the title alone.
  if (entry.stateBasis === 'title') {
    return keep(
      'unknown-state',
      `It reads ${entry.state} only from its terminal title; delete it on its own with omni session delete --force if you are sure.`
    )
  }
  if (entry.state === 'exited') {
    return remove('Exited.')
  }
  return remove(
    entry.archived
      ? 'Archived, idle, with nothing pending or waiting.'
      : 'Idle with no pending steps, no queue and nothing waiting on the person.'
  )
}

/** A stranded record goes only with `--unverified`; deleting it drops this computer's record only. */
function classifyStrandedMirrorRecord(
  entry: SessionManageEntry,
  options: { unverified: boolean; now: number },
  named: boolean,
  keep: (group: SessionTidyGroup, reason: string) => SessionTidyVerdict,
  remove: (reason: string, extra?: Partial<SessionTidyVerdict>) => SessionTidyVerdict
): SessionTidyVerdict {
  if (!options.unverified) {
    return keep(
      'unverifiable',
      `${STRANDED_MIRROR_RECORD_WHY} It cannot be verified, so it is kept; add --unverified to delete it.`
    )
  }
  const recent =
    entry.lastActivityAt !== null && options.now - entry.lastActivityAt < TIDY_DELETE_RECENT_MS
  if (recent && !named) {
    return keep('unverifiable', `${STRANDED_MIRROR_RECORD_WHY} It was active in the last hour.`)
  }
  return remove(
    `${STRANDED_MIRROR_RECORD_WHY} Deleting drops that record here; nothing runs or ends anywhere, and its history stays where it ran.`,
    { unverified: true }
  )
}
