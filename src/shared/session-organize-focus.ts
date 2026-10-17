/**
 * How many lines the default (focus) sidebar needs for a set of sessions, against the five-line
 * budget (plan §11), counted by the focus view's own ranking (session-focus-ranking.ts) so an
 * `omni session organize` dry run's "lines after" is what the sidebar will show.
 */

import { SAVED_SESSIONS_LABEL } from './session-folder-ref'
import {
  rankSessionFocusEntries,
  SESSION_FOCUS_LINE_LIMIT,
  SESSION_FOCUS_UNFILED_BUCKET,
  type SessionFocusRank
} from './session-focus-ranking'
import type { SessionManageState } from './session-manage-types'

export const SESSION_FOCUS_LINE_BUDGET = SESSION_FOCUS_LINE_LIMIT
export const SESSION_FOCUS_UNFILED = 'Unfiled'

export type SessionFocusRow = {
  /** Display path ("OmniRogue / Checkout", "Saved Sessions / Q3"); null when unfiled. */
  folder: string | null
  archived: boolean
  hidden: boolean
  snoozed: boolean
  state: SessionManageState
}

export type SessionFocusEstimate = {
  lines: number
  budget: number
  needsYou: number
  /** The folders that earn a line, most urgent first. */
  folders: string[]
  /** Folders with something happening that fold into Everything else for lack of room. */
  folded: string[]
  everythingElse: { sessions: number; folders: number }
}

const ASKING: ReadonlySet<SessionManageState> = new Set(['awaiting-user', 'waiting-for-yes'])
const RANK: Partial<Record<SessionManageState, SessionFocusRank>> = {
  working: 'working',
  queued: 'working',
  'provider-limited': 'waitingSoon'
}
const FOLDER_BUCKET = 'folder:'

function isSavedPath(folder: string): boolean {
  return folder.split(' / ')[0] === SAVED_SESSIONS_LABEL
}

/** The line a session counts under: its top-level folder ("Saved Sessions / X" for saved ones). */
export function sessionFocusGroup(folder: string | null): string {
  if (!folder) {
    return SESSION_FOCUS_UNFILED
  }
  const segments = folder.split(' / ')
  return segments[0] === SAVED_SESSIONS_LABEL && segments.length > 1
    ? segments.slice(0, 2).join(' / ')
    : segments[0]!
}

/**
 * `folderOrder`: top-level folder paths in the sidebar's order, which breaks ties between equally
 * busy folders as the sidebar does; without it, the order sessions are listed in does.
 */
export function estimateSessionFocusLines(
  rows: readonly SessionFocusRow[],
  folderOrder: readonly string[] = []
): SessionFocusEstimate {
  const order = new Map(folderOrder.map((path, index) => [`${FOLDER_BUCKET}${path}`, index]))
  const entries = rows.flatMap((row) => {
    const asking = ASKING.has(row.state)
    // Why as the sidebar does: archived, hidden and snoozed rows leave the view unless they ask.
    if ((row.archived || row.hidden || row.snoozed) && !asking) {
      return []
    }
    // Why the whole saved path: the sidebar counts each saved folder, and never gives it a line.
    const saved = row.folder !== null && isSavedPath(row.folder)
    const bucket = !row.folder
      ? SESSION_FOCUS_UNFILED_BUCKET
      : `${FOLDER_BUCKET}${saved ? row.folder : sessionFocusGroup(row.folder)}`
    if (!order.has(bucket)) {
      order.set(
        bucket,
        bucket === SESSION_FOCUS_UNFILED_BUCKET ? Number.MAX_SAFE_INTEGER : order.size
      )
    }
    return [
      {
        bucket,
        rankable: !saved,
        order: order.get(bucket)!,
        needsYou: asking,
        rank: RANK[row.state] ?? null
      }
    ]
  })
  const ranking = rankSessionFocusEntries(entries)
  const name = (bucket: string): string =>
    bucket === SESSION_FOCUS_UNFILED_BUCKET
      ? SESSION_FOCUS_UNFILED
      : bucket.slice(FOLDER_BUCKET.length)
  return {
    lines: ranking.lines,
    budget: SESSION_FOCUS_LINE_BUDGET,
    needsYou: ranking.needsYou,
    folders: ranking.folders.map(({ bucket }) => name(bucket)),
    folded: ranking.folded.map(name),
    everythingElse: ranking.everythingElse
  }
}
