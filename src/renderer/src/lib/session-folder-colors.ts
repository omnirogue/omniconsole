import { translate } from '@/i18n/i18n'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import { sessionFolderGroupKey, type SessionSidebarView } from './session-sidebar-view'

/** The colors a person can give a group; each maps to a `--session-folder-*` token in main.css. */
export const SESSION_FOLDER_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'gray'
] as const

export type SessionFolderColor = (typeof SESSION_FOLDER_COLORS)[number]

const KNOWN = new Set<string>(SESSION_FOLDER_COLORS)

export function isSessionFolderColor(value: unknown): value is SessionFolderColor {
  return typeof value === 'string' && KNOWN.has(value)
}

export function sessionFolderColorVar(color: SessionFolderColor): string {
  return `var(--session-folder-${color})`
}

export function sessionFolderColorLabel(color: SessionFolderColor): string {
  switch (color) {
    case 'red':
      return translate('conversations.folderColorRed', 'Red')
    case 'orange':
      return translate('conversations.folderColorOrange', 'Orange')
    case 'amber':
      return translate('conversations.folderColorAmber', 'Yellow')
    case 'green':
      return translate('conversations.folderColorGreen', 'Green')
    case 'teal':
      return translate('conversations.folderColorTeal', 'Teal')
    case 'blue':
      return translate('conversations.folderColorBlue', 'Blue')
    case 'violet':
      return translate('conversations.folderColorViolet', 'Purple')
    case 'pink':
      return translate('conversations.folderColorPink', 'Pink')
    case 'gray':
      return translate('conversations.folderColorGray', 'Gray')
  }
}

/** The color a group chose itself, ignoring what it inherits. */
export function ownSessionGroupColor(
  view: Pick<SessionSidebarView, 'colors'>,
  groupKey: string
): SessionFolderColor | null {
  const color = view.colors?.[groupKey]
  return isSessionFolderColor(color) ? color : null
}

/**
 * The color a group shows: its own, else the nearest colored folder above it. A saved folder's
 * chain ends at Saved Sessions, so coloring Saved Sessions colors everything saved.
 */
export function sessionGroupColor(
  view: Pick<SessionSidebarView, 'colors'>,
  groupKey: string,
  folder: SessionFolder | undefined,
  folders: readonly SessionFolder[]
): SessionFolderColor | null {
  const own = ownSessionGroupColor(view, groupKey)
  if (own || !folder) {
    return own
  }
  const byId = new Map(folders.map((entry) => [entry.id, entry] as const))
  const seen = new Set([folder.id])
  let parent = folder.parentId ? byId.get(folder.parentId) : undefined
  while (parent && !seen.has(parent.id)) {
    const color = ownSessionGroupColor(view, sessionFolderGroupKey(parent.id))
    if (color) {
      return color
    }
    seen.add(parent.id)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return folder.section === 'saved' ? ownSessionGroupColor(view, SAVED_SESSIONS_FOLDER_ID) : null
}
