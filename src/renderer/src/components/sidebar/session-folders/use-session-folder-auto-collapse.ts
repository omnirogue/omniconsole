import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ConversationRoutineGroup } from '@/lib/conversation-routine-rows'
import {
  foldersToAutoCollapse,
  groupKeysHoldingRow,
  groupsOpenedByHand,
  hoveredGroupProtectedKeys,
  protectedFolderGroupKeys
} from '@/lib/session-folder-auto-collapse'
import { groupsToFocus } from '@/lib/session-group-focus'
import {
  getSessionFolderId,
  type SessionFolder,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import { getSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import { useSessionFolders } from '@/store/session-folders'
import { sessionGroupFocusIdleSince, useSessionGroupFocus } from '@/store/session-group-focus'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { sidebarFolderEdits } from './session-sidebar-folder-edits'
import { savedSessionGroupKeys } from './use-session-group-select'
import { groupKeysRevealingRow } from './use-current-sidebar-row'

const TICK_MS = 1000

// Why module state: a drag opens folders from each group's own drop handler, not from this hook.
const autoOpenedGroupKeys = new Set<string>()

/** Opens folded groups for a drag passing through; the idle fold may close them again. */
export function openSessionGroupsForDrag(keys: readonly string[]): void {
  keys.forEach((key) => autoOpenedGroupKeys.add(key))
  useSessionSidebarView.getState().setCollapsed(keys, false)
}

/**
 * Unfolds where a session was just filed — the folder, every folder above it, and Saved
 * Sessions — and holds them open like folders opened by hand, so the drop stays in view.
 */
export function unfoldSessionDropDestination(
  folders: readonly SessionFolder[],
  folderId: string | null
): void {
  const keys = [...protectedFolderGroupKeys(folders, [folderId])]
  if (keys.length === 0) {
    return
  }
  keys.forEach((key) => autoOpenedGroupKeys.delete(key))
  useSessionSidebarView.getState().setCollapsed(keys, false)
}

/** Files one dropped session, then unfolds where it landed so it does not vanish from view. */
export function fileDroppedSession(sessionKey: string, folderId: string | null): void {
  if (sidebarFolderEdits.fileSession(sessionKey, folderId)) {
    unfoldSessionDropDestination(useSessionFolders.getState().metadata.folders, folderId)
  }
}

/** The group a pointer is over, by the nearest `[data-session-group]` around it. */
function groupKeyAt(target: EventTarget | null): string | null {
  return target instanceof Element
    ? (target.closest<HTMLElement>('[data-session-group]')?.dataset.sessionGroup ?? null)
    : null
}

/**
 * Folds an open group (a folder, Active, Done…) once it has sat idle for `seconds`: nothing in it
 * (or nested below it) needs the person, no row on screen is in it, nothing in it is
 * selected, and the pointer is not over it. Any of those restarts its clock; 0 turns this off.
 *
 * The group holding the conversation in use stays open, but after the same idle wait it folds
 * down to that conversation (and anything needing the person) under "Show all N".
 */
export function useSessionFolderAutoCollapse(args: {
  groups: readonly ConversationRoutineGroup[]
  metadata: SessionFolderMetadata
  /** The rows on the main screen (see useCurrentSidebarRow). */
  currentKeys: readonly string[]
  seconds: number
  listRef: React.RefObject<HTMLElement | null>
  onCollapse: (keys: readonly string[]) => void
}): void {
  const latest = useRef(args)
  useLayoutEffect(() => {
    latest.current = args
  })
  const hovered = useRef<string | null>(null)
  const idleSince = useRef(new Map<string, number>())
  const seenOpen = useRef(new Set<string>())
  const { seconds, listRef } = args

  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const over = (event: PointerEvent): void => {
      hovered.current = groupKeyAt(event.target)
    }
    const leave = (): void => {
      hovered.current = null
    }
    list.addEventListener('pointerover', over)
    list.addEventListener('pointerleave', leave)
    return () => {
      list.removeEventListener('pointerover', over)
      list.removeEventListener('pointerleave', leave)
    }
  }, [listRef])

  useEffect(() => {
    if (seconds <= 0) {
      idleSince.current.clear()
      useSessionGroupFocus.getState().reset()
      return
    }
    const timer = setInterval(() => {
      const { groups, metadata, currentKeys, onCollapse } = latest.current
      const selection = useSessionSelection.getState()
      const protectedKeys = protectedFolderGroupKeys(metadata.folders, [
        ...selection.keys.map((key) => getSessionFolderId(metadata, key)),
        ...selection.folderIds
      ])
      // A bulk selection must stay visible while its action bar or dialog is being used.
      for (const key of selection.keys) {
        for (const groupKey of groupKeysHoldingRow(groups, key)) {
          protectedKeys.add(groupKey)
        }
      }
      const selectedGroupKeys = new Set(protectedKeys)
      // Why: the groups around every row on screen (a status group such as Active or Done
      // included) stay open, so the person can always see where they are.
      const revealing = new Set(
        currentKeys.flatMap((currentKey) => groupKeysRevealingRow(groups, metadata, currentKey))
      )
      revealing.forEach((key) => protectedKeys.add(key))
      // Why: a folder the person opened on purpose stays open until they fold it.
      const byHand = groupsOpenedByHand({
        groups,
        revealing,
        autoOpened: autoOpenedGroupKeys,
        seenOpen: seenOpen.current
      })
      byHand.forEach((key) => protectedKeys.add(key))
      // Why: with Saved Sessions' eye on, every saved folder stays open until the eye is turned off.
      const savedKeys = useSessionSidebarView.getState().view.savedShowAll
        ? savedSessionGroupKeys(metadata.folders)
        : []
      savedKeys.forEach((key) => protectedKeys.add(key))
      const hoveredKey = hovered.current
      const dragging = getSessionSidebarDrag()
      // Why: only the pointer or a drag holds focus off; the row in use is what focus keeps.
      const focus = useSessionGroupFocus.getState()
      const toFocus = groupsToFocus({
        groups,
        keys: currentKeys,
        trimmed: focus.trimmed,
        protectedKeys: new Set(
          dragging
            ? groups.map((group) => group.key)
            : [hoveredKey ?? '', ...savedKeys, ...selectedGroupKeys]
        ),
        idleSince: sessionGroupFocusIdleSince,
        now: Date.now(),
        seconds
      })
      if (toFocus.length > 0) {
        focus.trim(toFocus)
      }
      for (const key of hoveredGroupProtectedKeys(metadata.folders, hoveredKey)) {
        protectedKeys.add(key)
      }
      // Why: folding a folder mid-drag would pull the drop target out from under the pointer.
      if (dragging) {
        for (const group of groups) {
          protectedKeys.add(group.key)
        }
      }
      const due = foldersToAutoCollapse({
        groups,
        protectedKeys,
        idleSince: idleSince.current,
        now: Date.now(),
        seconds
      })
      if (due.length > 0) {
        onCollapse(due)
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [seconds])
}
