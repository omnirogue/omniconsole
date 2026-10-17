import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getSessionFolderId,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolder
} from '@/lib/session-folders'
import { sessionFolderSubtreeIds, type SessionFolderSection } from '@/lib/session-folder-tree'
import {
  applyPersonOrganizationChange,
  type OrganizationChangeDeps
} from '@/lib/session-organization-change'
import type { SessionGroupDropTarget, SessionSidebarDragBatch } from '@/lib/session-sidebar-drag'
import { sessionFolderGroupKey } from '@/lib/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { isRoutineViewKey } from '../routines/routine-view-key'
import { isMirroredConversationLedgerKey } from '@/lib/mirrored-sidebar-conversation'
import { movableSessionKeys } from '@/lib/session-move-owner-guard'

/** The picked folders plus everything nested under them. */
function blockedIds(folders: readonly SessionFolder[], folderIds: readonly string[]): string[] {
  const blocked = new Set<string>()
  for (const id of folderIds) {
    for (const nested of sessionFolderSubtreeIds(folders, id)) {
      blocked.add(nested)
    }
  }
  return [...blocked]
}

/**
 * What a drag that starts on `item` carries: the whole selection when the item is part of a
 * selection of two or more things, otherwise nothing (the item moves alone, as before).
 */
export function sessionSidebarDragBatch(
  item: { sessionKey: string } | { folderId: string }
): SessionSidebarDragBatch | undefined {
  const { selected, keys, folderIds, explicit } = useSessionSelection.getState()
  const inSelection =
    'sessionKey' in item ? selected.has(item.sessionKey) : folderIds.has(item.folderId)
  // Why: a plain click also "selects" the row it opens; only a deliberate pick joins a batch. A
  // row the owner's ledger created is filed on its owner, so it never rides along (E1/F13).
  const sessionKeys = (
    explicit ? keys : 'sessionKey' in item && selected.has(item.sessionKey) ? [item.sessionKey] : []
  ).filter((key) => !isRoutineViewKey(key) && !isMirroredConversationLedgerKey(key))
  if (!inSelection || sessionKeys.length + folderIds.size < 2) {
    return undefined
  }
  const folders = useSessionFolders.getState().metadata.folders
  const pickedFolders = [...folderIds].filter((id) => folders.some((folder) => folder.id === id))
  return {
    sessionKeys,
    folderIds: pickedFolders,
    blockedFolderIds: blockedIds(folders, pickedFolders)
  }
}

type Destination = Exclude<SessionGroupDropTarget, { kind: 'group' }>

const BY_SIDEBAR = { kind: 'person', via: 'sidebar' } as const

/**
 * Moves a dragged selection: each picked folder (with its subfolders and sessions) goes inside
 * the destination, and each picked session is filed there — except sessions already inside a
 * picked folder, which ride along with it instead of being pulled out. The folders and the
 * sessions are one recorded change each, made by the person.
 */
export function moveSessionSidebarBatch(
  batch: Pick<SessionSidebarDragBatch, 'sessionKeys' | 'folderIds'>,
  destination: Destination,
  deps: OrganizationChangeDeps = {}
): { sessions: number; folders: number } {
  const store = useSessionFolders.getState()
  const { metadata } = store
  let parentId: string | null
  let section: SessionFolderSection
  let sessionFolderId: string | null
  if (destination.kind === 'row') {
    const folderId = destination.folderId
    parentId = folderId === SAVED_SESSIONS_FOLDER_ID ? null : folderId
    section =
      folderId === SAVED_SESSIONS_FOLDER_ID ||
      metadata.folders.some((folder) => folder.id === folderId && folder.section === 'saved')
        ? 'saved'
        : 'active'
    sessionFolderId = folderId
  } else {
    parentId = destination.parentId
    section = destination.section
    sessionFolderId = parentId ?? (section === 'saved' ? SAVED_SESSIONS_FOLDER_ID : null)
  }
  const picked = new Set(batch.folderIds)
  const riding = new Set(blockedIds(metadata.folders, batch.folderIds))
  const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
  // Why: a folder whose parent is also picked moves with that parent, keeping its place in it.
  const tops = batch.folderIds.filter((id) => {
    let parent = byId.get(id)?.parentId
    const seen = new Set([id])
    while (parent && !seen.has(parent)) {
      if (picked.has(parent)) {
        return false
      }
      seen.add(parent)
      parent = byId.get(parent)?.parentId
    }
    return true
  })
  const moving = tops.filter((id) => {
    const folder = byId.get(id)
    if (!folder || (parentId && sessionFolderSubtreeIds(metadata.folders, id).has(parentId))) {
      return false
    }
    const here =
      (folder.parentId ?? null) === parentId &&
      (folder.section === 'saved' ? 'saved' : 'active') === section
    return !here
  })
  let folders = 0
  if (moving.length > 0) {
    const { outcome } = applyPersonOrganizationChange(
      {
        kind: 'folder.move',
        targets: moving.map((folderId) => ({ folderId })),
        value: { parentId, section },
        executor: BY_SIDEBAR
      },
      deps
    )
    folders =
      outcome.status === 'applied'
        ? outcome.after.filter(
            (place, index) => JSON.stringify(place) !== JSON.stringify(outcome.before[index])
          ).length
        : 0
  }
  // Why the guard: a row its paired owner places is filed there (E1), so it leaves the batch.
  const sessionKeys = movableSessionKeys(batch.sessionKeys).filter((key) => {
    const current = getSessionFolderId(metadata, key)
    return !(current && riding.has(current))
  })
  let movedSessions = 0
  if (sessionKeys.length > 0) {
    const { outcome } = applyPersonOrganizationChange(
      {
        kind: 'move',
        targets: sessionKeys.map((sessionKey) => ({ sessionKey })),
        value: sessionFolderId,
        executor: BY_SIDEBAR
      },
      deps
    )
    movedSessions = outcome.status === 'applied' ? sessionKeys.length : 0
  }
  const unfold = parentId
    ? [sessionFolderGroupKey(parentId)]
    : section === 'saved'
      ? [SAVED_SESSIONS_FOLDER_ID]
      : []
  if (unfold.length > 0) {
    useSessionSidebarView.getState().setCollapsed(unfold, false)
  }
  useSessionSelection.getState().set([])
  if (movedSessions + folders > 0) {
    toast.success(
      translate('conversations.batchMoved', 'Moved {{sessions}} sessions and {{folders}} folders', {
        sessions: movedSessions,
        folders
      })
    )
  } else {
    const error = useSessionFolders.getState().error
    if (error) {
      toast.error(error)
    }
  }
  return { sessions: movedSessions, folders }
}
