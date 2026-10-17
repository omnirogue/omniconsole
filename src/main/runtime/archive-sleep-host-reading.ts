/**
 * The host half of "Archive = pause": before the window stops an archived agent, this host reads
 * it the way `omni session list` does (the Stage A1 reader, `session-manage-pty-activity.ts`), the
 * words of its last reply, and everything up next still holds for it. Only a positive `idle` with
 * a last reply read whole and asking nothing, and nothing pending, is clear; any reading that
 * fails, including a reply no source holds, keeps the agent.
 */

import {
  isOpenAskText,
  type ArchiveSleepHostReading,
  type ArchiveSleepReadingParams
} from '../../shared/archive-sleep-contract'
import type { ConversationSource } from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageState } from '../../shared/session-manage-types'
import type { SessionLatestTurn } from '../session-manage/session-manage-freeform'
import { findSessionManageRow } from '../session-manage/session-manage-inventory'

/** One place this host holds the conversation's last reply, and whether it holds it whole. */
export type ArchiveSleepReply = {
  text: string | null | undefined
  /** The agent's own words, read to their end: an absent or cut-off reply proves nothing. */
  whole: boolean
}

export type ArchiveSleepHostDeps = {
  rows(): Promise<readonly SessionManageSidebarRow[]>
  /** The Stage A1 state of one row. */
  state(row: SessionManageSidebarRow): Promise<SessionManageState>
  /** Every place this host holds the conversation's last reply (`archiveSleepReplies`). */
  replies(source: ConversationSource): readonly ArchiveSleepReply[]
  /** Up next's `archiveSleepClear`: nothing queued, drafted, held, kept going, planned, awaited. */
  nothingPending(source: ConversationSource): Promise<boolean>
}

const ASKING: ReadonlySet<SessionManageState> = new Set(['awaiting-user', 'waiting-for-yes'])

type HookReply = {
  state?: string
  lastAssistantMessage?: string
  lastAssistantMessageIsToolOutput?: boolean
}

/**
 * G1's two sources: the next-steps host's latest turn and the pane's newest hook row. The turn
 * counts only when the host established it and holds its whole reply (session-manage-freeform.ts
 * refuses an unknown turn too); the hook row only when it is a Done row carrying prose, not a
 * tool's output. Its preview is trimmed head and tail, so the ending, where a question sits, stays.
 */
export function archiveSleepReplies(
  turn: SessionLatestTurn,
  hook: HookReply | null | undefined
): ArchiveSleepReply[] {
  return [
    { text: turn.text, whole: turn.known && turn.complete },
    {
      text: hook?.lastAssistantMessage,
      whole: hook?.state === 'done' && hook.lastAssistantMessageIsToolOutput !== true
    }
  ]
}

function readWhole(reply: ArchiveSleepReply): boolean {
  return reply.whole && Boolean(reply.text?.trim())
}

export async function readArchiveSleepHost(
  deps: ArchiveSleepHostDeps,
  target: ArchiveSleepReadingParams,
  // Why: a session waiting on its own review page asks that page, not the person in the pane.
  options: { reviewWait?: boolean } = {}
): Promise<ArchiveSleepHostReading> {
  try {
    const row = findSessionManageRow(await deps.rows(), target)
    if (!row || row.worktreeId !== target.worktreeId) {
      return { clear: false, keep: 'unreadable' }
    }
    // Why every reading: a session executed on another computer is never stopped from here.
    if (
      row.kind !== 'terminal' ||
      row.hostUnavailable ||
      parseExecutionHostId(row.hostId)?.kind !== 'local'
    ) {
      return { clear: false, keep: 'not-local' }
    }
    const source: ConversationSource = {
      worktreeId: row.worktreeId,
      paneKey: target.paneKey,
      kind: 'pty'
    }
    const state = await deps.state(row)
    if (ASKING.has(state)) {
      return { clear: false, keep: 'open-ask', state }
    }
    if (state !== 'idle') {
      return { clear: false, keep: state === 'queued' ? 'pending' : 'not-idle', state }
    }
    const replies = deps.replies(source)
    if (!options.reviewWait && replies.some((reply) => isOpenAskText(reply.text))) {
      return { clear: false, keep: 'open-ask', state }
    }
    // Why: G1 fails closed. A reply no source read whole (an unread turn, a hook without the
    // message, a tool's stdout) may be the numbered questions Sal is about to answer.
    if (!replies.some(readWhole)) {
      return { clear: false, keep: 'unreadable', state }
    }
    if (!(await deps.nothingPending(source))) {
      return { clear: false, keep: 'pending', state }
    }
    return { clear: true, state }
  } catch {
    return { clear: false, keep: 'unreadable' }
  }
}
