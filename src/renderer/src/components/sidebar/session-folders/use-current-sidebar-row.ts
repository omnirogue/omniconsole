import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { conversationViewKey } from '@/lib/conversation-view'
import type {
  ConversationRoutineGroup,
  ConversationRoutineRow
} from '@/lib/conversation-routine-rows'
import { matchesRoutineConversation } from '@/lib/routine-backed-session'
import { sessionRowFolderId } from '@/lib/mirrored-conversation-folders'
import { groupKeysHoldingRow, protectedFolderGroupKeys } from '@/lib/session-folder-auto-collapse'
import { getSessionFolderId, type SessionFolderMetadata } from '@/lib/session-folders'
import { isSessionGroupCollapsed, type SessionSidebarView } from '@/lib/session-sidebar-view'
import { isSidebarSessionOnScreen, type OnScreenSession } from '@/lib/sidebar-session-on-screen'
import type { OnScreenSessionTarget } from '@/lib/sidebar-sessions-on-screen'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { useOnScreenSidebarSessions } from './use-selection-follows-screen'

/**
 * The row the main screen shows, by its view key: a routine's `routine:…` key when the tab on
 * screen is that routine's conversation, otherwise the conversation's own key.
 *
 * Why routines first: a routine's runs stay out of the list (its row stands for them), so matching
 * only conversations found no listed row for a routine on screen — its folders then folded away
 * under it and the checkmark stayed on whatever was selected before.
 */
export function currentSidebarRowKey(
  groups: readonly Pick<ConversationRoutineGroup, 'routineRows'>[],
  sessions: readonly SidebarSession[],
  screen: OnScreenSession
): string | null {
  if (!screen.tabId) {
    return null
  }
  for (const group of groups) {
    for (const row of group.routineRows) {
      const binding = row.automation.conversation
      if (!binding || binding.tabId !== screen.tabId) {
        continue
      }
      const leafId = binding.paneKey ? parsePaneKey(binding.paneKey)?.leafId : null
      if (!screen.leafId || !leafId || leafId === screen.leafId) {
        return row.key
      }
    }
  }
  const session = sessions.find((candidate) => isSidebarSessionOnScreen(candidate, screen))
  if (!session) {
    return null
  }
  // Why: a routine bound by session key (not tab) still owns this conversation's row.
  for (const group of groups) {
    for (const row of group.routineRows) {
      if (matchesRoutineConversation(session, row.automation.conversation)) {
        return row.key
      }
    }
  }
  return conversationViewKey(session)
}

/** The groups that must be open for the row to show: the ones listing it and every folder above. */
export function groupKeysRevealingRow(
  groups: readonly ConversationRoutineGroup[],
  metadata: SessionFolderMetadata,
  key: string | null
): string[] {
  if (!key) {
    return []
  }
  const keys = new Set(groupKeysHoldingRow(groups, key))
  // Why the row's own session when the tree lists it (C3): a paired owner's explicit folder places
  // the row, so the folders to unfold are the owner's, not a stale local membership's.
  const session = groups
    .flatMap((group) => group.rows)
    .find((row) => conversationViewKey(row.session) === key)?.session
  const folderId = session
    ? sessionRowFolderId(metadata, session, key)
    : getSessionFolderId(metadata, key)
  for (const folderKey of protectedFolderGroupKeys(metadata.folders, [folderId])) {
    keys.add(folderKey)
  }
  return [...keys]
}

/**
 * Which folded groups to open for the rows on screen, and the placements to remember. A row is
 * revealed when it comes on screen or moves to another group (a prompt carries a conversation
 * from Done into a folded Active); a row whose place is unchanged is left as the person folded it.
 */
export function groupsToRevealForRows(args: {
  currentKeys: readonly string[]
  groups: readonly ConversationRoutineGroup[]
  metadata: SessionFolderMetadata
  view: SessionSidebarView
  revealed: ReadonlyMap<string, string>
}): { expand: string[]; revealed: Map<string, string> } {
  const revealed = new Map<string, string>()
  const expand = new Set<string>()
  for (const key of args.currentKeys) {
    const keys = groupKeysRevealingRow(args.groups, args.metadata, key)
    if (keys.length === 0) {
      continue
    }
    const placement = [...keys].sort().join('\n')
    revealed.set(key, placement)
    if (args.revealed.get(key) === placement) {
      continue
    }
    for (const groupKey of keys) {
      if (isSessionGroupCollapsed(args.view, groupKey)) {
        expand.add(groupKey)
      }
    }
  }
  // Why a fresh map: a row that leaves the screen and comes back is revealed again.
  return { expand: [...expand], revealed }
}

/**
 * Opens the groups around each row on screen whenever one comes on screen or moves to another
 * group, so the person always sees which conversations are in front and which folders hold
 * them. Only on such a change: folding a group by hand afterwards sticks.
 */
export function useRevealCurrentRows(args: {
  currentKeys: readonly string[]
  groups: readonly ConversationRoutineGroup[]
  metadata: SessionFolderMetadata
  view: SessionSidebarView
  onExpand: (keys: readonly string[]) => void
}): void {
  const latest = useRef(args)
  useLayoutEffect(() => {
    latest.current = args
  })
  const revealed = useRef<ReadonlyMap<string, string>>(new Map())
  const { currentKeys, groups, metadata } = args
  // Why the groups as a trigger: a just-launched conversation is on screen a beat before its row
  // is listed or filed, and a prompt moves a listed row between status groups.
  const placements = useMemo(
    () =>
      currentKeys
        .map((key) => `${key}\n${groupKeysRevealingRow(groups, metadata, key).sort().join('\n')}`)
        .join('\n\n'),
    [currentKeys, groups, metadata]
  )
  useEffect(() => {
    const next = groupsToRevealForRows({ ...latest.current, revealed: revealed.current })
    revealed.current = next.revealed
    if (next.expand.length > 0) {
      latest.current.onExpand(next.expand)
    }
  }, [placements])
}

/**
 * The rows on the main screen, and what follows them: the groups around each opening, the
 * checkmark on the focused one, and routine rows drawn as current. Why after routines: a
 * routine's conversation on screen is that routine's row, not a session's.
 */
export function useCurrentSidebarRow(
  routines: {
    groups: readonly ConversationRoutineGroup[]
    renderRoutineRow: (
      row: ConversationRoutineRow,
      group: { key: string },
      currentKey?: string | null
    ) => React.ReactNode
  },
  sessions: readonly SidebarSession[],
  list: {
    folders: { metadata: SessionFolderMetadata }
    viewStore: {
      view: SessionSidebarView
      setCollapsed: (keys: readonly string[], collapsed: boolean) => void
    }
  }
): {
  /** The focused row on screen. */
  currentKey: string | null
  /** Every row on screen, the focused one first. */
  currentKeys: readonly string[]
  onScreen: readonly OnScreenSessionTarget[]
  renderRoutineRow: (row: ConversationRoutineRow, group: { key: string }) => React.ReactNode
} {
  const { groups, renderRoutineRow: render } = routines
  const { metadata } = list.folders
  const { viewStore } = list
  // Why: the tabs on the main screen, in row identity — not the store's terminal-only activeTabId.
  const onScreen = useOnScreenSidebarSessions()
  const { currentKey, currentKeys } = useMemo(() => {
    const keys: string[] = []
    let focused: string | null = null
    const add = (key: string): void => {
      if (!keys.includes(key)) {
        keys.push(key)
      }
    }
    for (const target of onScreen) {
      const key = currentSidebarRowKey(groups, sessions, target)
      if (key) {
        add(key)
        if (target.focused && focused === null) {
          focused = key
        }
      }
      // Why: a whole tab on screen shows every pane split inside it, not only the first.
      if (!target.leafId) {
        for (const session of sessions) {
          if (isSidebarSessionOnScreen(session, target)) {
            add(conversationViewKey(session))
          }
        }
      }
    }
    const ordered = focused ? [focused, ...keys.filter((key) => key !== focused)] : keys
    return { currentKey: focused, currentKeys: ordered }
  }, [groups, sessions, onScreen])
  const { setCollapsed } = viewStore
  useRevealCurrentRows({
    currentKeys,
    groups,
    metadata,
    view: viewStore.view,
    onExpand: (keys) => setCollapsed(keys, false)
  })
  const renderRoutineRow = useCallback(
    (row: ConversationRoutineRow, group: { key: string }) =>
      // Why: a routine on screen beside the focused conversation is current too.
      render(row, group, currentKeys.includes(row.key) ? row.key : currentKey),
    [render, currentKey, currentKeys]
  )
  return { currentKey, currentKeys, onScreen, renderRoutineRow }
}
