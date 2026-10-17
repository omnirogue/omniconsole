/**
 * `omni session history` and `omni session actions` as text: one readable line per record,
 * "time · what · who · reason · evidence · undoable".
 */

import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../shared/session-organization-change'
import type {
  OrganizationActionsResult,
  OrganizationSessionHistory,
  SessionActionLine
} from '../shared/session-organization-readers'

/** Folder id → display path, so a move reads "Moved to Clients / Acme", not an id. */
export type FolderNames = ReadonlyMap<string, string>

const SAVED_ROOT = 'saved-sessions'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local `HH:MM` today, `YYYY-MM-DD HH:MM` on another day. */
export function formatActionTime(ts: string, now: Date = new Date()): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) {
    return ts
  }
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`
}

function placeName(value: unknown, folders: FolderNames): string {
  if (value === null || value === undefined) {
    return 'Unfiled'
  }
  if (value === SAVED_ROOT) {
    return 'Saved Sessions'
  }
  return typeof value === 'string' ? (folders.get(value) ?? value) : JSON.stringify(value)
}

function quoted(value: unknown): string {
  return typeof value === 'string' && value.trim() ? `“${value}”` : 'its default name'
}

const ORIGIN_WORDS = {
  yours: 'your words',
  generated: 'generated',
  unknown: 'origin unknown'
} as const

type Described = Pick<OrganizationRecord, 'kind' | 'value' | 'targets' | 'origin' | 'undoOf'>

/** What the change did, in words. */
export function describeOrganizationChange(record: Described, folders: FolderNames): string {
  const { value } = record
  let what: string
  switch (record.kind) {
    case 'move':
      what = `Moved to ${placeName(value, folders)}`
      break
    case 'save':
      what = 'Saved'
      break
    case 'archive':
      what = 'Archived'
      break
    case 'unarchive':
      what = 'Unarchived'
      break
    case 'delete':
      what = value === false ? 'Restored from deleted' : 'Deleted'
      break
    case 'title':
      what = `Renamed to ${quoted(value)}${record.origin ? ` (${ORIGIN_WORDS[record.origin]})` : ''}`
      break
    case 'finish-action':
      what = 'Finished'
      break
    case 'folder.create':
      what = 'Folder created'
      break
    case 'folder.rename':
      what = `Folder renamed to ${quoted(value)}`
      break
    case 'folder.move':
      what = 'Folder moved'
      break
    case 'folder.delete':
      what = 'Folder deleted'
      break
    case 'folder.color':
      what = value ? `Folder colored ${String(value)}` : 'Folder color cleared'
      break
    case 'folder.reorder':
      what = 'Folders reordered'
      break
    case 'folder.project':
      what = value === null ? 'Project settings removed' : 'Project settings saved'
      break
    case 'tag':
      what = `Tagged ${String(value)}`
      break
    case 'untag':
      what = `Untagged ${String(value)}`
      break
    case 'hide':
      what = 'Hidden'
      break
    case 'unhide':
      what = 'Shown again'
      break
    case 'snooze':
      what = typeof value === 'number' ? `Snoozed until ${new Date(value).toISOString()}` : 'Woken'
      break
    case 'sleep':
      what = 'Archive paused the agent (opening it resumes the conversation)'
      break
  }
  const count = record.targets.length
  return `${record.undoOf ? 'Undo: ' : ''}${what}${count > 1 ? ` (${count} sessions)` : ''}`
}

/** Who made it: the person, a session by name, the CLI, a launch, another device or the app. */
export function describeExecutor(executor: OrganizationExecutor): string {
  switch (executor.kind) {
    case 'person':
      return `by you (${executor.via})`
    case 'pane':
      return `by “${executor.title}” (session)`
    case 'cli':
      return 'by the omni CLI'
    case 'launch':
      return `by a launch (${executor.source})`
    case 'sync':
      return 'by another device (sync)'
    case 'app':
      return executor.feature === 'steward'
        ? 'by the Session steward'
        : `by the app (${executor.feature})`
  }
}

function tail(
  record: Pick<OrganizationRecord, 'reason' | 'request' | 'evidence'>,
  extra: (string | null)[]
): string[] {
  return [
    record.reason ? `reason: ${record.reason}` : null,
    record.request ? `asked: “${record.request}”` : null,
    record.evidence ? `evidence: ${record.evidence}` : null,
    ...extra
  ].filter((part): part is string => part !== null)
}

export function formatOrganizationRecordLine(
  record: OrganizationRecord,
  options: { folders: FolderNames; undoable: boolean; now?: Date }
): string {
  const status =
    record.phase === 'failed'
      ? `failed: ${record.error ?? 'unknown'}`
      : record.phase === 'prepared'
        ? 'interrupted, not reconciled yet'
        : null
  return [
    formatActionTime(record.ts, options.now),
    describeOrganizationChange(record, options.folders),
    describeExecutor(record.executor),
    ...tail(record, [status, options.undoable ? 'undoable' : null])
  ].join(' · ')
}

export function formatSessionHistory(
  history: OrganizationSessionHistory,
  folders: FolderNames = new Map(),
  now?: Date
): string {
  const undoable = new Set(history.undoable ?? [])
  const heading = history.row
    ? `History of “${history.row.title}” (${history.row.viewKey})`
    : `History of ${history.key}`
  const lines = [...history.pending, ...history.entries].map((record) =>
    formatOrganizationRecordLine(record, { folders, undoable: undoable.has(record.opId), now })
  )
  const revoked = Object.entries(history.revocations).map(
    ([field, revocation]) =>
      `${field === 'title' ? 'Title' : 'Placement'} is yours for good (${formatActionTime(revocation.at, now)}): agents and sync never take it back.`
  )
  return [heading, ...(lines.length > 0 ? lines : ['No recorded changes.']), ...revoked].join('\n')
}

function legacyActor(actor: SessionActionLine['actor']): string {
  if (typeof actor === 'object') {
    return `by “${actor.title}” (session)`
  }
  if (actor === 'steward') {
    return 'by the Session steward'
  }
  return actor === 'cli' ? 'by the omni CLI' : `by ${actor}`
}

export function formatSessionActionLine(
  line: SessionActionLine,
  folders: FolderNames,
  now?: Date
): string {
  const body = line.organization
  if (body && line.executor && line.opId && line.phase) {
    return formatOrganizationRecordLine(
      {
        ...body,
        opId: line.opId,
        phase: line.phase,
        ts: line.ts,
        executor: line.executor,
        ...(line.origin ? { origin: line.origin } : {}),
        ...(line.reason ? { reason: line.reason } : {}),
        ...(line.request ? { request: line.request } : {})
      },
      { folders, undoable: false, now }
    )
  }
  return [
    formatActionTime(line.ts, now),
    line.summary,
    legacyActor(line.actor),
    ...tail(line, [])
  ].join(' · ')
}

export function formatSessionActions(
  result: OrganizationActionsResult,
  folders: FolderNames = new Map(),
  now?: Date
): string {
  return result.actions.length > 0
    ? result.actions.map((line) => formatSessionActionLine(line, folders, now)).join('\n')
    : 'No recorded actions in this window.'
}
