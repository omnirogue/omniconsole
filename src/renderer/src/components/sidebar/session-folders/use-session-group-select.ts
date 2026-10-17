import { useCallback, useLayoutEffect, useState } from 'react'
import { useSessionGroupFocus } from '@/store/session-group-focus'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  conversationFleetRowKey,
  type ConversationFleetSidebarRow
} from '@/lib/conversation-fleet-sidebar'
import { conversationViewKey } from '@/lib/conversation-view'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from '@/lib/session-folders'
import { sessionFolderSubtreeIds } from '@/lib/session-folder-tree'
import { sessionFolderGroupKey, type SessionSidebarGroup } from '@/lib/session-sidebar-tree'

/** `archived-older`: only what was archived (or, unstamped, finished) at least a week ago. */
export type SessionGroupSelectMode = 'all' | 'archived-older'

export const SESSION_ARCHIVED_OLDER_THAN_MS = 7 * 24 * 60 * 60_000

type SelectableGroup = SessionSidebarGroup & {
  fleetRows?: readonly ConversationFleetSidebarRow[]
  routineRows?: readonly { key: string }[]
}

/** The group and every saved folder nested under it: all of them open before a select-all. */
export function sessionGroupSubtreeKeys(
  group: Pick<SessionSidebarGroup, 'key' | 'kind' | 'folder'>,
  folders: readonly SessionFolder[]
): string[] {
  const saved = folders.filter((folder) => folder.section === 'saved')
  if (group.kind === 'saved') {
    return [group.key, ...saved.map((folder) => sessionFolderGroupKey(folder.id))]
  }
  if (group.folder?.section === 'saved') {
    return [...sessionFolderSubtreeIds(saved, group.folder.id)].map(sessionFolderGroupKey)
  }
  return [group.key]
}

/** Saved Sessions and every saved folder, by group key. */
export function savedSessionGroupKeys(folders: readonly SessionFolder[]): string[] {
  return sessionGroupSubtreeKeys({ key: SAVED_SESSIONS_FOLDER_ID, kind: 'saved' }, folders)
}

/**
 * The view keys a select-all takes from the groups on screen, or null while any group in the
 * subtree is still folded (its rows are not listed yet, so selecting now would miss them).
 */
export function sessionGroupSelectionKeys(args: {
  groups: readonly SelectableGroup[]
  subtreeKeys: readonly string[]
  mode: SessionGroupSelectMode
  archivedAt: Readonly<Record<string, number>> | undefined
  now: number
}): string[] | null {
  const inTree = new Set(args.subtreeKeys)
  const members = args.groups.filter((group) => inTree.has(group.key))
  if (members.some((group) => group.collapsed)) {
    return null
  }
  const cutoff = args.now - SESSION_ARCHIVED_OLDER_THAN_MS
  const olderThanCutoff = (key: string, completedAt?: number): boolean => {
    const at = args.archivedAt?.[key] ?? completedAt
    return at !== undefined && at <= cutoff
  }
  const keys = members.flatMap((group) => [
    ...group.rows
      .filter(
        (row) =>
          args.mode === 'all' ||
          olderThanCutoff(conversationViewKey(row.session), row.completed?.at)
      )
      .map((row) => conversationViewKey(row.session)),
    // Why: a receipt from another computer lists in the group too, so its select-all takes it.
    ...(group.fleetRows ?? [])
      .map((fleet) => conversationFleetRowKey(fleet.run, fleet.source))
      .filter((key) => args.mode === 'all' || olderThanCutoff(key)),
    ...(group.routineRows ?? [])
      .map((routine) => routine.key)
      .filter((key) => args.mode === 'all' || olderThanCutoff(key))
  ])
  return [...new Set(keys)]
}

/** "Select all" on a group's menu: unfold its subtree, then select what it lists. */
export function useSessionGroupSelect(
  groups: readonly SelectableGroup[],
  folders: readonly SessionFolder[],
  view: {
    view: { archivedAt?: Readonly<Record<string, number>> }
    setCollapsed: (keys: readonly string[], collapsed: boolean) => void
  },
  selectKeys: (keys: readonly string[]) => void
): (group: SessionSidebarGroup, mode: SessionGroupSelectMode) => void {
  const archivedAt = view.view.archivedAt
  const { setCollapsed } = view
  const [pending, setPending] = useState<{
    key: string
    subtreeKeys: string[]
    mode: SessionGroupSelectMode
  } | null>(null)
  useLayoutEffect(() => {
    if (!pending) {
      return
    }
    // Why: a group that left the list (filtered, emptied) can never become ready.
    if (!groups.some((group) => group.key === pending.key)) {
      setPending(null)
      return
    }
    const keys = sessionGroupSelectionKeys({
      groups,
      subtreeKeys: pending.subtreeKeys,
      mode: pending.mode,
      archivedAt,
      now: Date.now()
    })
    if (keys === null) {
      return
    }
    setPending(null)
    if (keys.length === 0) {
      if (pending.mode !== 'archived-older') {
        return
      }
      toast.info(
        translate(
          'conversations.selectArchivedOlderNone',
          'Nothing here was archived more than 7 days ago.'
        )
      )
      return
    }
    selectKeys(keys)
  }, [pending, groups, archivedAt, selectKeys])
  return useCallback(
    (group, mode) => {
      const subtreeKeys = sessionGroupSubtreeKeys(group, folders)
      subtreeKeys.forEach((key) => useSessionGroupFocus.getState().showAll(key))
      setCollapsed(subtreeKeys, false)
      setPending({ key: group.key, subtreeKeys, mode })
    },
    [folders, setCollapsed]
  )
}
