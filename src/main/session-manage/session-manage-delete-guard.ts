import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { remoteExecutionRefusal } from './session-manage-locality'

export type SessionDeleteOptions = {
  /** Stop and delete a working agent (`--force`). */
  force?: boolean
  /**
   * The person's request also covers a session this computer runs but cannot verify
   * (`--unverified`): no terminal attached, its state unknown, or a tab with no pane. Its row
   * goes here and no terminal is ended: what it lists may be a live session shown elsewhere.
   */
  unverified?: boolean
}

/**
 * Why `omni session delete` refuses this conversation, or null when it may go. Never one another
 * computer or an SSH host runs (closing its tab here would stop it there); one this computer runs
 * but cannot verify only with `--unverified`; without `--force`, never one working, nor one whose
 * state rests on its terminal title alone.
 */
export function sessionDeleteRefusal(
  entry: SessionManageEntry,
  options: SessionDeleteOptions
): string | null {
  const name = `“${entry.title}”`
  const remote = remoteExecutionRefusal(entry, 'delete')
  if (remote) {
    const host = parseExecutionHostId(entry.hostId)
    return host?.kind === 'runtime'
      ? `${remote} Closing its tab here would stop it on that computer; delete it there (omni session delete or omni session tidy --delete on that computer), or hide it here with omni session hide.`
      : remote
  }
  if (entry.state === 'working' && !options.force) {
    return `${name} is still working. Deleting it stops the agent (its history can be reopened from Recently closed); pass --force to stop and delete it.`
  }
  const unverifiable = entry.verdict === 'unverifiable' || entry.state === 'unknown'
  if (unverifiable) {
    return options.unverified
      ? null
      : `${name} cannot be verified (${entry.waitingOn ?? 'its state is unknown'}), so it was not deleted. Unknown is never treated as dead; when the person asks, delete it with --unverified (its row goes here; no terminal is ended), or from the sidebar.`
  }
  if (options.force) {
    return null
  }
  if (entry.stateBasis === 'title') {
    return `${name} reads ${entry.state} only from its terminal title, which never decides a delete on its own, so it was not deleted. Pass --force if you are sure it is not working.`
  }
  return null
}

/**
 * Why a conversation a paired computer runs and lists in its conversation ledger is never deleted
 * here (session parity, step 7, C4): its execution owner is that computer, so neither `--force`
 * nor `--unverified` applies. The person deletes it on that computer, or hides it here.
 */
export function mirroredConversationDeleteRefusal(title: string): string {
  return `“${title}” runs on another computer, which lists it, so it was not deleted here (--unverified included): deleting here would not reach that computer. Delete it there (omni session delete on that computer), or hide it here with omni session hide.`
}

/**
 * Why a record-only row of another computer's pane may not be deleted, or null (A4). Its only
 * substance here is this computer's saved record: deleting it drops that record and ends nothing
 * anywhere, and the owner lists no such row to delete there. Only the person's `--unverified`
 * request lets it go.
 */
export function recordOnlyMirrorDeleteRefusal(
  title: string,
  options: SessionDeleteOptions,
  stranded: boolean
): string | null {
  if (options.unverified) {
    return null
  }
  const where = stranded
    ? 'and no computer lists its workspace'
    : 'and that computer no longer lists it'
  return `“${title}” is only this computer's saved record of another computer's conversation, ${where}, so it cannot be verified and was not deleted. When the person asks, delete it with --unverified (only that record goes here; nothing ends anywhere), or from the sidebar.`
}
