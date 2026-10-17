import type { SessionFolderMetadata } from '@/lib/session-folders'
import type { Stamped, Synced, SyncedFolders } from '../../../../shared/account-sync-session-docs'
import type { LocalProjection } from './session-sync-local'

export type SyncedField = 'placement' | 'archived'

/** A session's synced folder (id, or null for none) or archive state, under one local key. */
export type SyncedStampedValue = {
  field: SyncedField
  key: string
  value: string | null | boolean
  stamp: number
}

/** A synced value as a pass reads it, with what this computer holds now and whether it wrote it. */
export type IncomingSyncedValue = SyncedStampedValue & {
  local: string | null | boolean
  /** This computer authored the winning stamp (in this pass or an earlier one). */
  ours: boolean
}

export type SyncAppliedChange = {
  field: SyncedField
  key: string
  before: string | null | boolean
  after: string | null | boolean
  stamp: number
}

/** What organization records and ownership need from each pass (optional; see session-sync-ownership). */
export type SessionSyncOrganization = {
  /** In the pass that stamped them, so their echo reads as this computer's own. */
  noteAuthoredStamps: (authored: SyncedStampedValue[]) => void
  /** Every stamp a pass reads for a session here, before equal values are skipped. */
  onIncoming: (incoming: IncomingSyncedValue) => void
  /** Once per pass: what it changed here, each with the stamp that changed it. */
  recordApplied: (changes: SyncAppliedChange[]) => void
}

/** Every stamp this pass authored, by each local key its session sits under. */
export function authoredSyncStamps(edits: Synced, now: LocalProjection): SyncedStampedValue[] {
  return Object.entries(edits.sessions).flatMap(([digest, edit]) =>
    (now.sessions[digest]?.keys ?? []).flatMap((key) => [
      ...(edit.f ? [{ field: 'placement' as const, key, value: edit.f[0], stamp: edit.f[1] }] : []),
      ...(edit.a
        ? [{ field: 'archived' as const, key, value: edit.a[0] !== null, stamp: edit.a[1] }]
        : [])
    ])
  )
}

const sameStamped = (left: Stamped<unknown> | undefined, right: Stamped<unknown> | undefined) =>
  !!left && !!right && left[1] === right[1] && JSON.stringify(left[0]) === JSON.stringify(right[0])

/** Whether the account's winning stamp for a session field is one this computer authored. */
export function isAuthoredHere(
  authored: Synced,
  merged: Synced,
  digest: string,
  field: SyncedField
): boolean {
  const pick = field === 'placement' ? 'f' : 'a'
  return sameStamped(authored.sessions[digest]?.[pick], merged.sessions[digest]?.[pick])
}

/**
 * What a pass changed here, by local key: each key's folder that differs after it and each
 * archive it set, stamped with the synced value that did it (or the deleted folder's tombstone).
 */
export function syncAppliedChanges(input: {
  before: SessionFolderMetadata
  after: SessionFolderMetadata | null
  archive: readonly string[]
  unarchive: readonly string[]
  stamps: ReadonlyMap<string, number>
  folders: SyncedFolders
  fallback: number
}): SyncAppliedChange[] {
  const { before, after, stamps, folders, fallback } = input
  const changes: SyncAppliedChange[] = []
  const was = before.membership
  const is = after?.membership ?? was
  for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
    const from = was[key] ?? null
    const to = is[key] ?? null
    if (from !== to) {
      const tombstone = from ? folders[from]?.t : undefined
      const stamp = stamps.get(`placement\0${key}`) ?? tombstone ?? fallback
      changes.push({ field: 'placement', key, before: from, after: to, stamp })
    }
  }
  for (const [keys, archived] of [
    [input.archive, true],
    [input.unarchive, false]
  ] as const) {
    for (const key of keys) {
      const stamp = stamps.get(`archived\0${key}`) ?? fallback
      changes.push({ field: 'archived', key, before: !archived, after: archived, stamp })
    }
  }
  return changes
}
