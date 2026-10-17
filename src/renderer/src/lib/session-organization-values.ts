import { automaticArchiveRefusal, automaticArchiveReceipt } from './session-automatic-archive-guard'
import { archiveSleepViaOf } from '../../../shared/archive-sleep-contract'
import { withArchiveExecutor } from './session-archive-events'
import { translate } from '@/i18n/i18n'
import {
  organizationValueAt,
  type OrganizationChange,
  type OrganizationChangeKind,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import type { SessionFolderCliStores } from './session-folder-cli-op-helpers'
import { isSessionFolderColor } from './session-folder-colors'
import { getSessionFolderId, SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import type { ProjectSettings } from '../../../shared/project-settings'
import { sessionFolderGroupKey } from './session-sidebar-view'
import {
  applyOrganizationViewChange,
  isOrganizationViewKind,
  readOrganizationViewValue,
  type OrganizationViewStores
} from './session-organization-view-values'
import {
  appTitleStore,
  organizationTitleOrigin,
  organizationTitleTabId,
  type OrganizationTitleStore
} from './session-organization-title'

/** The sidebar stores an organization change reads and writes. */
export type OrganizationStores = SessionFolderCliStores &
  OrganizationViewStores & { titles?: OrganizationTitleStore }

export type OrganizationRead = { known: true; value: unknown } | { known: false }

const UNKNOWN: OrganizationRead = { known: false }
const known = (value: unknown): OrganizationRead => ({ known: true, value })

function colorKey(folderId: string): string {
  return folderId === SAVED_SESSIONS_FOLDER_ID
    ? SAVED_SESSIONS_FOLDER_ID
    : sessionFolderGroupKey(folderId)
}

/**
 * What one target holds now for the field a kind changes; unknown when it is not in the sidebar.
 * `value` is the change's value for that target (tag kinds read whether it has that tag).
 */
export function readOrganizationValue(
  kind: OrganizationChangeKind,
  target: OrganizationTarget,
  stores: OrganizationStores,
  value?: unknown
): OrganizationRead {
  if (isOrganizationViewKind(kind)) {
    return readOrganizationViewValue(kind, target, stores, value)
  }
  const { metadata } = stores.folders.getState()
  const view = stores.view.getState()
  const session = target.sessionKey
  const folder = metadata.folders.find((entry) => entry.id === target.folderId)
  switch (kind) {
    case 'move':
    case 'save':
      return session ? known(getSessionFolderId(metadata, session)) : UNKNOWN
    case 'archive':
    case 'unarchive':
      return session ? known(view.archived.includes(session)) : UNKNOWN
    case 'delete':
      return session ? known((view.view.deleted ?? []).includes(session)) : UNKNOWN
    case 'folder.move':
      return folder
        ? known({
            parentId: folder.parentId ?? null,
            section: folder.section === 'saved' ? 'saved' : 'active'
          })
        : UNKNOWN
    case 'folder.rename':
      return folder ? known(folder.name) : UNKNOWN
    case 'folder.color':
      return target.folderId
        ? known(view.view.colors?.[colorKey(target.folderId)] ?? null)
        : UNKNOWN
    case 'folder.project':
      return folder ? known(metadata.projects?.[folder.id] ?? null) : UNKNOWN
    case 'title': {
      const tabId = organizationTitleTabId(target)
      const read = tabId ? (stores.titles ?? appTitleStore).read(tabId) : null
      return read?.known ? known(read.title) : UNKNOWN
    }
    // Why unknown: nothing reads these; the view kinds (tag, hide, snooze) return above.
    case 'finish-action':
    case 'sleep':
    case 'folder.create':
    case 'folder.delete':
    case 'folder.reorder':
    case 'tag':
    case 'untag':
    case 'hide':
    case 'unhide':
    case 'snooze':
      return UNKNOWN
  }
}

const APPLIED_KINDS: ReadonlySet<OrganizationChangeKind> = new Set([
  'move',
  'archive',
  'unarchive',
  'delete',
  'folder.move',
  'folder.rename',
  'folder.color',
  'folder.project',
  'title',
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
])

function noApplier(kind: OrganizationChangeKind): string {
  return `No change path applies a ${kind} yet.`
}

/** Every target's value, or null when any is unknown (a record's arrays are never partial). */
export function readOrganizationValues(
  kind: OrganizationChangeKind,
  targets: readonly OrganizationTarget[],
  stores: OrganizationStores,
  change?: Pick<OrganizationChange, 'value' | 'values'>
): unknown[] | null {
  const reads = targets.map((target, index) =>
    readOrganizationValue(kind, target, stores, change && organizationValueAt(change, index))
  )
  return reads.every((read) => read.known)
    ? reads.map((read) => (read as { value: unknown }).value)
    : null
}

/** Target indexes grouped by the value they take, so one store call applies each group. */
function groupsOf(change: OrganizationChange): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  change.targets.forEach((_target, index) => {
    const key = JSON.stringify(organizationValueAt(change, index) ?? null)
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  return groups
}

function sessionKeys(change: OrganizationChange, indexes: readonly number[]): string[] {
  return indexes
    .map((index) => change.targets[index]?.sessionKey)
    .filter((key): key is string => Boolean(key))
}

/** Runs a change against the stores; returns the first refusal, or null. */
export type OrganizationStoreAction = (
  change: OrganizationChange,
  stores: OrganizationStores
) => string | null

/** Applies through the sidebar's own store actions; the first store refusal, if any. */
function applyByKind(change: OrganizationChange, stores: OrganizationStores): string | null {
  if (isOrganizationViewKind(change.kind)) {
    return applyOrganizationViewChange(change, stores)
  }
  const storeError = (fallback: string): string => stores.folders.getState().error ?? fallback
  let refusal: string | null = null
  for (const [value, indexes] of groupsOf(change)) {
    const parsed: unknown = JSON.parse(value)
    const keys = sessionKeys(change, indexes)
    const folderIds = indexes
      .map((index) => change.targets[index]?.folderId)
      .filter((id): id is string => Boolean(id))
    switch (change.kind) {
      case 'move':
        if (
          !stores.folders.getState().moveSessions(keys, typeof parsed === 'string' ? parsed : null)
        ) {
          refusal ??= storeError('Could not move the conversation.')
        }
        break
      case 'archive':
        if (change.executor.kind === 'app' && change.executor.feature === 'steward') {
          for (const key of keys) {
            if (!stores.view.getState().archiveVerified(key, automaticArchiveReceipt(key))) {
              return 'The automatic archive receipt could not be saved.'
            }
          }
          break
        }
        stores.view.getState().setArchived(keys, true)
        break
      case 'unarchive':
        stores.view.getState().setArchived(keys, false)
        break
      case 'delete':
        stores.view.getState().setDeleted(keys, parsed === true)
        break
      case 'folder.move': {
        const place = parsed as { parentId?: string | null; section?: 'saved' | 'active' } | null
        for (const id of folderIds) {
          if (!stores.folders.getState().moveFolder(id, place?.parentId ?? null, place?.section)) {
            refusal ??= storeError('Could not move the folder.')
          }
        }
        break
      }
      case 'folder.rename':
        for (const id of folderIds) {
          if (typeof parsed !== 'string' || !stores.folders.getState().renameFolder(id, parsed)) {
            refusal ??= storeError('Could not rename the folder.')
          }
        }
        break
      case 'folder.color':
        for (const id of folderIds) {
          stores.view
            .getState()
            .setGroupColor(colorKey(id), isSessionFolderColor(parsed) ? parsed : null)
        }
        break
      case 'folder.project': {
        // Why the shape check: only settings or null reach the store; a stray falsy value would remove them.
        const valid = parsed === null || (typeof parsed === 'object' && !Array.isArray(parsed))
        for (const id of folderIds) {
          const settings = parsed as ProjectSettings | null
          if (!valid || !stores.folders.getState().setProjectSettings(id, settings)) {
            refusal ??= storeError('Could not save the project settings.')
          }
        }
        break
      }
      case 'title': {
        const titles = stores.titles ?? appTitleStore
        const origin = organizationTitleOrigin(change)
        for (const index of indexes) {
          const tabId = organizationTitleTabId(change.targets[index] ?? {})
          if (!tabId || !titles.read(tabId).known) {
            refusal ??= 'Could not rename the conversation: its tab is gone.'
            continue
          }
          // Why untrimmed: an Undo must put back the exact words; an empty title resets it.
          titles.write(tabId, typeof parsed === 'string' && parsed.trim() ? parsed : null, {
            origin,
            recordInteraction: change.executor.kind === 'person'
          })
        }
        break
      }
      // Why tag/hide/snooze too: they apply through applyOrganizationViewChange, never here.
      case 'save':
      case 'finish-action':
      case 'sleep':
      case 'folder.create':
      case 'folder.delete':
      case 'folder.reorder':
      case 'tag':
      case 'untag':
      case 'hide':
      case 'unhide':
      case 'snooze':
        return noApplier(change.kind)
    }
  }
  return refusal
}

export type OrganizationApplied = {
  before: unknown[]
  after: unknown[]
  /** At least one target now holds a different value. */
  changed: boolean
  error?: string
}

/**
 * Reads every target, applies, reads again: the record states what actually changed. `act`
 * replaces the generic applier where a store action carries more than the value (a receipt, a
 * proof, an archive origin).
 */
export function applyOrganizationValues(
  change: OrganizationChange,
  stores: OrganizationStores,
  act?: OrganizationStoreAction
): OrganizationApplied | { error: string } {
  if (!act && !APPLIED_KINDS.has(change.kind)) {
    return { error: noApplier(change.kind) }
  }
  const before = readOrganizationValues(change.kind, change.targets, stores, change)
  if (!before) {
    return {
      error: translate(
        'conversations.organization.targetGone',
        'A target of this change is no longer in the sidebar.'
      )
    }
  }
  stores.folders.setState({ error: null })
  let error: string | null
  try {
    // Why the scope: the archive notice names who archived (archive-sleeps-idle-agents.ts).
    error =
      automaticArchiveRefusal(change) ??
      withArchiveExecutor(archiveSleepViaOf(change.executor), () =>
        (act ?? applyByKind)(change, stores)
      )
  } catch (thrown) {
    // Why caught: a prepared change must still settle, as failed or partly applied.
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }
  const after = readOrganizationValues(change.kind, change.targets, stores, change) ?? before
  const changed = after.some(
    (value, index) => JSON.stringify(value) !== JSON.stringify(before[index])
  )
  return { before, after, changed, ...(error ? { error } : {}) }
}
