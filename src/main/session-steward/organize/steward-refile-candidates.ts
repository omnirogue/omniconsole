/**
 * Which sessions the steward may re-file (Phase 3 §1) and which folders it offers JEV. Only local,
 * idle, unpinned, unsaved sessions whose placement is the steward's or launch's own (or nobody's,
 * never revoked by a person), with no person action in the last day.
 */

import type { SessionFolderEntry } from '../../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../../shared/session-manage-types'
import {
  isStewardExecutor,
  type OrganizationHistory
} from '../../../shared/session-organization-change'
import {
  sessionOwnerEligibility,
  sessionOwnerLoad
} from '../../session-manage/session-manage-owner-load'
import { STEWARD_FOLDER_CHOICES_MAX, type StewardFolderChoice } from './steward-organize-jev'

const DAY_MS = 24 * 60 * 60 * 1000
/** A person's own change this recent leaves the session alone. */
export const STEWARD_PERSON_QUIET_MS = DAY_MS

/** One observed sidebar row, as the organizing pass reads it. */
export type StewardOrganizeRow = {
  row: SessionManageSidebarRow
  entry: SessionManageEntry
  /** A running chain owns the conversation (`runtimeChainBound`). */
  bound: boolean
}

/** Whose placement this is, read from the ledger; null when the steward may not move it. */
export function stewardMayPlace(
  row: Pick<SessionManageSidebarRow, 'folderId'>,
  history: Pick<OrganizationHistory, 'entries' | 'ownership' | 'revocations' | 'pending'>,
  now: number
): boolean {
  if (history.pending.length > 0 || history.revocations.placement) {
    return false
  }
  const personRecently = history.entries.some(
    (record) =>
      record.executor.kind === 'person' && now - Date.parse(record.ts) < STEWARD_PERSON_QUIET_MS
  )
  if (personRecently) {
    return false
  }
  const owner = history.ownership.placement
  if (!owner) {
    return row.folderId === null
  }
  if (owner.by === 'launch') {
    return true
  }
  const record = history.entries.find((entry) => entry.opId === owner.opId)
  return owner.by === 'app' && record !== undefined && isStewardExecutor(record.executor)
}

/** Local, idle and free, not pinned or saved: the row side of the candidate rule. */
export function stewardRowMayMove(observed: StewardOrganizeRow): boolean {
  const { row, entry, bound } = observed
  return (
    sessionOwnerEligibility({ row, entry }, new Set()).eligible &&
    sessionOwnerLoad(entry, bound).light &&
    !row.pinned &&
    !row.saved &&
    !row.archived &&
    row.hidden !== true
  )
}

function topLevel(path: string | null): string | null {
  return path ? (path.split(' / ')[0] ?? null) : null
}

/**
 * Up to 30 folders for one session: never Saved, a batch folder or its current folder; folders
 * holding sessions of the same repo first, then its own top-level folder, then the fullest.
 */
export function stewardFolderChoices(
  observed: StewardOrganizeRow,
  folders: readonly SessionFolderEntry[],
  rows: readonly StewardOrganizeRow[],
  batchFolderIds: ReadonlySet<string>
): StewardFolderChoice[] {
  const { row } = observed
  const sameRepo = new Set(
    rows
      .filter((other) => row.repoId !== null && other.row.repoId === row.repoId)
      .map((other) => other.row.folderId)
      .filter((id): id is string => id !== null)
  )
  const home = topLevel(row.folder)
  const rank = (folder: SessionFolderEntry): number =>
    sameRepo.has(folder.id) ? 0 : home !== null && topLevel(folder.path) === home ? 1 : 2
  return folders
    .filter(
      (folder) =>
        folder.section === 'active' && folder.id !== row.folderId && !batchFolderIds.has(folder.id)
    )
    .toSorted(
      (left, right) =>
        rank(left) - rank(right) ||
        right.sessionCount - left.sessionCount ||
        left.path.localeCompare(right.path)
    )
    .slice(0, STEWARD_FOLDER_CHOICES_MAX)
    .map((folder) => ({ id: folder.id, path: folder.path }))
}
