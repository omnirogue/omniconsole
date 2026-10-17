import { conversationState } from './conversation-state'
import { sessionStillNeedsOwnerReview } from '../../../shared/session-archive-proof'
import type { SessionProjectThreadStatus } from '../../../shared/session-project-thread-status'
import type { SessionFolder } from './session-folders'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import { rowNeedsPerson } from './session-sidebar-tree-order'
import { sessionRowTone } from './session-row-tone'

/**
 * What a folder holds at a glance: how many of its sessions (nested ones and archived ones too)
 * work, need the person, wait, stopped, cannot be seen or are done. `total` also counts rows in
 * none of these, such as an idle conversation.
 */
export type SessionFolderTally = {
  working: number
  needsYou: number
  waiting: number
  stopped: number
  cantSee: number
  done: number
  /** The `done` rows that are Ready for review; they stay in `done`, so older readers are unchanged. */
  reviewReady?: number
  total: number
}

export type SessionFolderTallyState = Exclude<keyof SessionFolderTally, 'total' | 'reviewReady'>

export type { SessionProjectThreadStatus }

const TALLY_COUNTS = [
  'working',
  'needsYou',
  'waiting',
  'stopped',
  'cantSee',
  'done',
  'total'
] as const satisfies readonly (keyof SessionFolderTally)[]

/** The row's place in its folder's tally; null for one that is none of them (idle, no agent). */
export function sessionFolderRowState(
  row: SessionSidebarTreeRow,
  classification?: string
): SessionFolderTallyState | null {
  // Why first: a row whose host cannot be reached is unknown, never done nor anything else.
  if (row.session.unavailable || row.activityUnverifiable) {
    return 'cantSee'
  }
  const needsYou = rowNeedsPerson(row)
  if (row.archived && !needsYou) {
    return 'done'
  }
  const visualState =
    row.pursuitState ??
    conversationState({ state: row.state, needsYou, waiting: row.waitingUntil !== null })
  if (visualState === 'unverifiable') {
    return 'cantSee'
  }
  const tone = sessionRowTone({ visualState, needsYou, putAway: false })
  if (tone === 'needs-you') {
    return 'needsYou'
  }
  if (classification === 'completed' || tone === 'done') {
    return 'done'
  }
  switch (tone) {
    case 'active':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'stopped':
      return 'stopped'
    case null:
      return null
  }
}

/**
 * A finished, unarchived row that still holds something for its owner: an outcome run sealed for
 * their review, a finished turn nobody has opened, or (when the caller passes it) an open or draft
 * pull or merge request on its workspace. Never a question: the owner's review is where finished
 * work goes (Sal, 2026-09-19).
 */
function readyForReview(row: SessionSidebarTreeRow, openReview: boolean | undefined): boolean {
  return (
    !row.archived &&
    Boolean(
      (row.pursuitChain && sessionStillNeedsOwnerReview(row.pursuitChain)) ||
      row.unreadCompletion ||
      openReview
    )
  )
}

/**
 * A project thread's status: `sessionFolderRowState` with `done` split into `reviewReady` and
 * `done` (Completed). `openReview` is the caller's to set, only for a thread that is the only
 * session in its workspace and never for the coordinator.
 */
export function sessionProjectThreadStatus(
  row: SessionSidebarTreeRow,
  classification?: string,
  openReview?: boolean
): SessionProjectThreadStatus | null {
  const state = sessionFolderRowState(row, classification)
  return state === 'done' && readyForReview(row, openReview) ? 'reviewReady' : state
}

export function emptySessionFolderTally(): SessionFolderTally {
  return { working: 0, needsYou: 0, waiting: 0, stopped: 0, cantSee: 0, done: 0, total: 0 }
}

/**
 * Every folder's tally over its whole subtree, archived members included. `openReview` adds the
 * hosted-review signal to the `reviewReady` count; without it only the seal and unread finishes
 * count there.
 */
export function sessionFolderTallies(
  folders: readonly SessionFolder[],
  rows: readonly SessionSidebarTreeRow[],
  classifications: ReadonlyMap<string, string>,
  openReview?: (row: SessionSidebarTreeRow) => boolean
): Map<string, SessionFolderTally> {
  const own = new Map<string, SessionFolderTally>()
  for (const row of rows) {
    if (!row.folderId) {
      continue
    }
    const tally = own.get(row.folderId) ?? emptySessionFolderTally()
    const state = sessionFolderRowState(row, classifications.get(row.session.rowKey))
    if (state) {
      tally[state] += 1
    }
    if (state === 'done' && readyForReview(row, openReview?.(row))) {
      tally.reviewReady = (tally.reviewReady ?? 0) + 1
    }
    tally.total += 1
    own.set(row.folderId, tally)
  }
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId) {
      children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder.id])
    }
  }
  const tallies = new Map<string, SessionFolderTally>()
  const subtree = (id: string): SessionFolderTally => {
    const cached = tallies.get(id)
    if (cached) {
      return cached
    }
    const tally = { ...(own.get(id) ?? emptySessionFolderTally()) }
    // Why seed first: a looped parent link must not recurse forever.
    tallies.set(id, tally)
    for (const child of children.get(id) ?? []) {
      const part = subtree(child)
      for (const key of TALLY_COUNTS) {
        tally[key] += part[key]
      }
      if (part.reviewReady) {
        tally.reviewReady = (tally.reviewReady ?? 0) + part.reviewReady
      }
    }
    return tally
  }
  for (const folder of folders) {
    subtree(folder.id)
  }
  return tallies
}

/**
 * Batch folders whose every session is archived: finished work that drops out of the default
 * view. A folder the person made (no recorded origin), one holding a subfolder, or one with no
 * sessions at all never hides itself.
 */
export function settledBatchFolderIds(
  folders: readonly SessionFolder[],
  rows: readonly SessionSidebarTreeRow[],
  batchFolderIds: ReadonlySet<string>
): Set<string> {
  const settled = new Set<string>()
  if (batchFolderIds.size === 0) {
    return settled
  }
  const parents = new Set(folders.flatMap((folder) => (folder.parentId ? [folder.parentId] : [])))
  const members = new Map<string, { archived: number; open: number }>()
  for (const row of rows) {
    if (!row.folderId || !batchFolderIds.has(row.folderId)) {
      continue
    }
    const count = members.get(row.folderId) ?? { archived: 0, open: 0 }
    count[row.archived ? 'archived' : 'open'] += 1
    members.set(row.folderId, count)
  }
  for (const folder of folders) {
    const count = members.get(folder.id)
    if (batchFolderIds.has(folder.id) && !parents.has(folder.id) && count && count.open === 0) {
      settled.add(folder.id)
    }
  }
  return settled
}
