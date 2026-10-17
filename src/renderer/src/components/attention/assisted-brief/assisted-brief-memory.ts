import { parseAssistedBriefRecord } from '../../../../../shared/assisted-brief-record-schema'
import { currentRevisionStart } from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord } from '../../../../../shared/assisted-brief-types'

/** Bounded on write and on read; a brief with its kept revisions stays far below this. */
export const ASSISTED_BRIEF_STORAGE_MAX_CHARS = 400_000

const storageKey = (scope: string, worktreeId: string): string =>
  `assisted-brief-v1:${scope}:${worktreeId}`

export type SavedBriefRead = { record: AssistedBriefRecord | null; unreadable: boolean }

/** The saved text as stored; undefined when storage refuses the read. */
export function readSavedBriefText(
  storage: Storage,
  scope: string,
  worktreeId: string
): string | null | undefined {
  try {
    return storage.getItem(storageKey(scope, worktreeId))
  } catch {
    return undefined
  }
}

/**
 * Validates saved text. Data that fails validation is reported as unreadable rather than
 * repaired, so no approval or start decision rests on a guess.
 */
export function parseSavedBriefText(raw: string | null | undefined): SavedBriefRead {
  if (raw === undefined || (raw && raw.length > ASSISTED_BRIEF_STORAGE_MAX_CHARS)) {
    return { record: null, unreadable: true }
  }
  if (!raw) {
    return { record: null, unreadable: false }
  }
  try {
    return { record: parseAssistedBriefRecord(JSON.parse(raw)), unreadable: false }
  } catch {
    return { record: null, unreadable: true }
  }
}

/** The saved brief for this person and workspace. */
export function readSavedBrief(
  storage: Storage,
  scope: string,
  worktreeId: string
): SavedBriefRead {
  return parseSavedBriefText(readSavedBriefText(storage, scope, worktreeId))
}

export type SavedBriefLaunchState = 'none' | 'saved' | 'started'

/**
 * What the launch strip offers: a new brief, the saved one to reopen, or a new brief beside
 * one whose current revision already started. Unreadable data reopens to its discard notice.
 */
export function savedBriefLaunchState(saved: SavedBriefRead): SavedBriefLaunchState {
  if (saved.unreadable) {
    return 'saved'
  }
  if (!saved.record) {
    return 'none'
  }
  return currentRevisionStart(saved.record)?.status === 'started' ? 'started' : 'saved'
}

/** Validates before writing; throws when the brief is invalid, too large or storage refuses it. */
export function writeSavedBrief(
  storage: Storage,
  scope: string,
  worktreeId: string,
  record: AssistedBriefRecord
): void {
  const serialized = JSON.stringify(parseAssistedBriefRecord(record))
  if (serialized.length > ASSISTED_BRIEF_STORAGE_MAX_CHARS) {
    throw new Error('The brief is too large to save.')
  }
  storage.setItem(storageKey(scope, worktreeId), serialized)
}

/** Removes the saved brief only when it is still the one the person chose to discard. */
export function discardSavedBrief(
  storage: Storage,
  scope: string,
  worktreeId: string,
  briefId: string | null
): void {
  const saved = readSavedBrief(storage, scope, worktreeId)
  if (saved.unreadable || saved.record?.briefId === briefId) {
    storage.removeItem(storageKey(scope, worktreeId))
  }
}
