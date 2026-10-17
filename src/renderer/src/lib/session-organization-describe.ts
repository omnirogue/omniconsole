/**
 * One recorded organization change in words for the History section and the Steward activity
 * card: what it did, and who did it. The CLI prints the same facts in English
 * (src/cli/session-history-format.ts).
 */

import { translate } from '@/i18n/i18n'
import { SAVED_SESSIONS_LABEL, sessionFolderDisplayPath } from '../../../shared/session-folder-ref'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'

type Described = Pick<OrganizationRecord, 'kind' | 'value' | 'targets' | 'origin' | 'undoOf'>

function placeName(value: unknown, folders: readonly SessionFolder[]): string {
  if (value === null || value === undefined) {
    return translate('conversations.history.unfiled', 'Unfiled')
  }
  if (value === SAVED_SESSIONS_FOLDER_ID) {
    return SAVED_SESSIONS_LABEL
  }
  const folder = folders.find((entry) => entry.id === value)
  return folder ? sessionFolderDisplayPath(folders, folder) : String(value)
}

function titleText(value: unknown): string {
  return typeof value === 'string' && value.trim()
    ? value
    : translate('conversations.history.defaultName', 'its default name')
}

function originText(origin: OrganizationRecord['origin']): string | null {
  switch (origin) {
    case 'yours':
      return translate('conversations.history.originYours', 'your words')
    case 'generated':
      return translate('conversations.history.originGenerated', 'generated')
    case 'unknown':
      return translate('conversations.history.originUnknown', 'origin unknown')
    case undefined:
      return null
  }
}

function whatText(record: Described, folders: readonly SessionFolder[]): string {
  const { value } = record
  switch (record.kind) {
    case 'move':
      return translate('conversations.history.moved', 'Moved to {{place}}', {
        place: placeName(value, folders)
      })
    case 'save':
      return translate('conversations.history.saved', 'Saved')
    case 'archive':
      return translate('conversations.history.archived', 'Archived')
    case 'unarchive':
      return translate('conversations.history.unarchived', 'Unarchived')
    case 'delete':
      return value === false
        ? translate('conversations.history.restored', 'Restored from deleted')
        : translate('conversations.history.deleted', 'Deleted')
    case 'title': {
      const origin = originText(record.origin)
      return origin
        ? translate('conversations.history.renamedOrigin', 'Renamed to “{{title}}” ({{origin}})', {
            title: titleText(value),
            origin
          })
        : translate('conversations.history.renamed', 'Renamed to “{{title}}”', {
            title: titleText(value)
          })
    }
    case 'finish-action':
      return translate('conversations.history.finished', 'Finished')
    case 'folder.create':
      return translate('conversations.history.folderCreated', 'Folder created')
    case 'folder.rename':
      return translate('conversations.history.folderRenamed', 'Folder renamed to “{{title}}”', {
        title: titleText(value)
      })
    case 'folder.move':
      return translate('conversations.history.folderMoved', 'Folder moved')
    case 'folder.delete':
      return translate('conversations.history.folderDeleted', 'Folder deleted')
    case 'folder.color':
      return translate('conversations.history.folderColored', 'Folder color changed')
    case 'folder.reorder':
      return translate('conversations.history.foldersReordered', 'Folders reordered')
    case 'folder.project':
      return value === null
        ? translate('conversations.history.projectRemoved', 'Project settings removed')
        : translate('conversations.history.projectSaved', 'Project settings saved')
    case 'tag':
      return translate('conversations.history.tagged', 'Tagged {{tag}}', { tag: String(value) })
    case 'untag':
      return translate('conversations.history.untagged', 'Untagged {{tag}}', {
        tag: String(value)
      })
    case 'hide':
      return translate('conversations.history.hidden', 'Hidden')
    case 'unhide':
      return translate('conversations.history.unhidden', 'Shown again')
    case 'snooze':
      return typeof value === 'number'
        ? translate('conversations.history.snoozed', 'Snoozed until {{when}}', {
            when: new Date(value).toLocaleString()
          })
        : translate('conversations.history.woken', 'Woken')
    case 'sleep':
      return translate(
        'conversations.history.archivePaused',
        'Archive paused the agent (opening it resumes the conversation)'
      )
  }
}

/** What the change did; an Undo and a change to many sessions say so. */
export function describeOrganizationWhat(
  record: Described,
  folders: readonly SessionFolder[]
): string {
  const what = whatText(record, folders)
  const withUndo = record.undoOf
    ? translate('conversations.history.undoOf', 'Undo: {{what}}', { what })
    : what
  return record.targets.length > 1
    ? translate('conversations.history.manySessions', '{{what}} ({{count}} sessions)', {
        what: withUndo,
        count: record.targets.length
      })
    : withUndo
}

/** Who made it. */
export function describeOrganizationWho(executor: OrganizationExecutor): string {
  switch (executor.kind) {
    case 'person':
      return translate('conversations.history.byYou', 'by you')
    case 'pane':
      return translate('conversations.history.bySession', 'by “{{title}}”', {
        title: executor.title
      })
    case 'cli':
      return translate('conversations.history.byCli', 'by the omni CLI')
    case 'launch':
      return translate('conversations.history.byLaunch', 'by a launch')
    case 'sync':
      return translate('conversations.history.bySync', 'by another device')
    case 'app':
      return executor.feature === 'steward'
        ? translate('conversations.history.bySteward', 'by the Session steward')
        : translate('conversations.history.byApp', 'by the app')
  }
}

/** `10:12`, or the date too when it was not today. */
export function describeOrganizationTime(ts: string, now: Date = new Date()): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) {
    return ts
  }
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}
