import { conversationViewKey } from './conversation-view'
import { sessionFolderSubtreeIds } from './session-folder-tree'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import type { SessionSidebarGroup, SessionSidebarTreeRow } from './session-sidebar-group-model'
import { sessionFolderGroupKey } from './session-sidebar-view'

/**
 * The group keys that must stay open because something the person is using sits in them: each
 * given folder, every folder above it, and Saved Sessions when it is a saved folder. A folded
 * ancestor would hide the folder just as surely as folding the folder itself.
 */
export function protectedFolderGroupKeys(
  folders: readonly SessionFolder[],
  folderIds: Iterable<string | null | undefined>
): Set<string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const keys = new Set<string>()
  for (const folderId of folderIds) {
    if (!folderId) {
      continue
    }
    if (folderId === SAVED_SESSIONS_FOLDER_ID) {
      keys.add(SAVED_SESSIONS_FOLDER_ID)
      continue
    }
    let folder = byId.get(folderId)
    const seen = new Set<string>()
    while (folder && !seen.has(folder.id)) {
      seen.add(folder.id)
      keys.add(sessionFolderGroupKey(folder.id))
      if (folder.section === 'saved') {
        keys.add(SAVED_SESSIONS_FOLDER_ID)
      }
      folder = folder.parentId ? byId.get(folder.parentId) : undefined
    }
  }
  return keys
}

/**
 * What the pointer over a group keeps open: that group, every folder above it, and every folder
 * below it. Why below: a subfolder opened inside the parent being worked in must not fold away.
 */
export function hoveredGroupProtectedKeys(
  folders: readonly SessionFolder[],
  hoveredKey: string | null
): Set<string> {
  if (!hoveredKey) {
    return new Set()
  }
  if (hoveredKey === SAVED_SESSIONS_FOLDER_ID) {
    const saved = folders.filter((folder) => folder.section === 'saved')
    return new Set([hoveredKey, ...saved.map((folder) => sessionFolderGroupKey(folder.id))])
  }
  const folderId = hoveredKey.startsWith('folder:') ? hoveredKey.slice(7) : null
  const keys = protectedFolderGroupKeys(folders, [folderId])
  keys.add(hoveredKey)
  if (folderId) {
    for (const id of sessionFolderSubtreeIds(folders, folderId)) {
      keys.add(sessionFolderGroupKey(id))
    }
  }
  return keys
}

/** Folders and Saved Sessions: the groups a person opens by hand to keep open. */
const HAND_OPENABLE = new Set<SessionSidebarGroup['kind']>(['folder', 'saved'])

/**
 * The open folders (and Saved Sessions) the person opened by hand, so the idle fold leaves them.
 * Everything else that opens a folder is automatic: a drag hovering it (`autoOpened`, noted by
 * the caller) or the reveal of a row on screen (`revealing` when first seen open). Both sets are
 * updated in place; a folder seen folding again forgets how it was opened.
 */
export function groupsOpenedByHand(args: {
  groups: readonly Pick<SessionSidebarGroup, 'key' | 'kind' | 'collapsed'>[]
  revealing: ReadonlySet<string>
  autoOpened: Set<string>
  seenOpen: Set<string>
}): Set<string> {
  const { groups, revealing, autoOpened, seenOpen } = args
  const byHand = new Set<string>()
  for (const group of groups) {
    if (!HAND_OPENABLE.has(group.kind)) {
      continue
    }
    if (group.collapsed) {
      // Why only after it was seen open: a drag's open lands a render after it is noted.
      if (seenOpen.delete(group.key)) {
        autoOpened.delete(group.key)
      }
      continue
    }
    if (!seenOpen.has(group.key)) {
      seenOpen.add(group.key)
      if (revealing.has(group.key)) {
        autoOpened.add(group.key)
      }
    }
    if (!autoOpened.has(group.key)) {
      byHand.add(group.key)
    }
  }
  return byHand
}

/** Groups a person opens on purpose to look through (not work lists), so they never fold themselves. */
const NEVER_AUTO_FOLDED = new Set<SessionSidebarGroup['kind']>(['attention', 'archived', 'hidden'])

function rowsHold(rows: readonly SessionSidebarTreeRow[], key: string): boolean {
  return rows.some(
    (row) =>
      conversationViewKey(row.session) === key ||
      (row.children ? rowsHold(row.children, key) : false)
  )
}

/**
 * The groups a row (conversation or routine key) is listed in. Why: the open conversation may sit
 * in a status group (Active, Done) rather than a folder, and that group must stay open around it.
 */
export function groupKeysHoldingRow(
  groups: readonly (Pick<SessionSidebarGroup, 'key' | 'rows'> & {
    routineRows?: readonly { key: string }[]
  })[],
  key: string | null
): string[] {
  if (!key) {
    return []
  }
  return groups
    .filter(
      (group) =>
        rowsHold(group.rows, key) || (group.routineRows?.some((row) => row.key === key) ?? false)
    )
    .map((group) => group.key)
}

/**
 * One tick of the auto-fold: which open groups (folders, Active, Done…) have sat idle — nothing in them needing the
 * person, nothing protected — for `seconds`. `idleSince` (group key → ms) is updated in place:
 * a protected or busy folder restarts its clock, and a folder that is no longer open forgets it,
 * so reopening one always gives it the full wait again.
 */
export function foldersToAutoCollapse(args: {
  groups: readonly Pick<SessionSidebarGroup, 'key' | 'kind' | 'collapsed' | 'attentionCount'>[]
  protectedKeys: ReadonlySet<string>
  idleSince: Map<string, number>
  now: number
  seconds: number
}): string[] {
  const { groups, protectedKeys, idleSince, now, seconds } = args
  const open = new Set<string>()
  const due: string[] = []
  for (const group of groups) {
    if (NEVER_AUTO_FOLDED.has(group.kind) || group.collapsed) {
      continue
    }
    open.add(group.key)
    // Why: a folder holding something that needs the person stays open; that is what it is for.
    if (protectedKeys.has(group.key) || group.attentionCount > 0 || !idleSince.has(group.key)) {
      idleSince.set(group.key, now)
      continue
    }
    if (seconds > 0 && now - idleSince.get(group.key)! >= seconds * 1000) {
      due.push(group.key)
    }
  }
  for (const key of idleSince.keys()) {
    if (!open.has(key) || due.includes(key)) {
      idleSince.delete(key)
    }
  }
  return due
}
