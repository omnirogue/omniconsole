import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useSessionSelection } from '@/store/session-selection'
import {
  emptySessionSelection,
  extendSessionSelection,
  pruneSessionSelection,
  selectAllSessions,
  sessionSelectionIntent,
  stepSessionSelection,
  updateSessionSelection,
  type SessionSelection
} from './session-multi-selection'

// Why: mirrors the worktree list's guard, which is not exported. xterm's hidden textarea is
// not a text field a person types into, so it must not swallow list shortcuts either.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

/** The element inside a row that carries the roving tabIndex. */
export const SESSION_ROW_FOCUS_SELECTOR = '[data-session-open]'

/**
 * Selection state for the Conversations list. `visibleKeys` is the displayed order across
 * expanded groups; anything not in it is pruned before a person can act on it.
 */
export function useSessionMultiSelection(
  visibleKeys: readonly string[],
  listRef: React.RefObject<HTMLElement | null>,
  /** Scrolls a windowed-out row into a virtualized list before it is focused. */
  revealRef?: React.RefObject<((key: string) => void) | null>
) {
  const shared = useSessionSelection()
  const selection = useMemo<SessionSelection>(
    () => ({ selected: new Set(shared.keys), anchor: shared.anchor, focus: shared.focus }),
    [shared.keys, shared.anchor, shared.focus]
  )
  // Why: filters and live reordering change the list under a selection; prune before children
  // render so an unseen row is never counted or acted on (same device as the kanban board).
  const pruned =
    shared.scope === 'visible' ? pruneSessionSelection(selection, visibleKeys) : selection
  useLayoutEffect(() => {
    if (pruned !== selection) {
      useSessionSelection.getState().setGesture(pruned, shared.explicit)
    }
  }, [pruned, selection, shared.explicit])
  const pendingFocus = useRef<string | null>(null)
  // Why: gestures read the latest selection from a ref so two in one tick compose, and the
  // next state is computed outside the setter (React may run an updater more than once).
  const latest = useRef(pruned)
  useLayoutEffect(() => {
    latest.current = pruned
  }, [pruned])
  // Why: a plain click or arrow picks one row on the way to opening it; the bulk bar would
  // shout "1 selected" at every open. It appears for a deliberate gesture or a real batch.
  const explicit = shared.explicit

  const apply = useCallback(
    (
      next: (previous: SessionSelection) => SessionSelection,
      options: { moveFocus?: boolean; explicit: boolean }
    ): void => {
      const result = next(pruneSessionSelection(latest.current, visibleKeys))
      latest.current = result
      if (options.moveFocus) {
        pendingFocus.current = result.focus
      }
      useSessionSelection.getState().setGesture(result, options.explicit)
    },
    [visibleKeys]
  )

  useEffect(() => {
    const key = pendingFocus.current
    if (!key || pruned.focus !== key) {
      return
    }
    pendingFocus.current = null
    // Why: keys carry colons and quotes; matching the attribute beats escaping it for a selector.
    const findRow = (): HTMLElement | undefined =>
      [...(listRef.current?.querySelectorAll<HTMLElement>('[data-session-key]') ?? [])].find(
        (candidate) => candidate.dataset.sessionKey === key
      )
    const focusRow = (row: HTMLElement): void => {
      row.scrollIntoView?.({ block: 'nearest' })
      row.querySelector<HTMLElement>(SESSION_ROW_FOCUS_SELECTOR)?.focus()
    }
    const row = findRow()
    if (row) {
      focusRow(row)
      return
    }
    const reveal = revealRef?.current
    if (!reveal) {
      return
    }
    // Why: a windowed list mounts the row only after the scroll it asks for has rendered.
    reveal(key)
    const frame = requestAnimationFrame(() => {
      const revealed = findRow()
      if (revealed) {
        focusRow(revealed)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [listRef, pruned.focus, revealRef])

  /** Returns true when the click was a selection gesture the caller must not treat as "open". */
  const select = useCallback(
    (event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>, key: string): boolean => {
      const intent = sessionSelectionIntent(event, navigator.userAgent.includes('Mac'))
      if (intent === 'replace') {
        // Why: a plain click picks one session and drops any folders picked before it.
        useSessionSelection.getState().clearFolders()
      }
      apply(
        (previous) => updateSessionSelection({ visibleKeys, previous, targetKey: key, intent }),
        { explicit: intent !== 'replace' }
      )
      return intent !== 'replace'
    },
    [apply, visibleKeys]
  )

  const clear = useCallback(() => {
    useSessionSelection.getState().clearFolders()
    apply(() => emptySessionSelection(), { explicit: false })
  }, [apply])

  /** Select exactly these keys as a deliberate batch, e.g. everything in one folder. */
  const selectKeys = useCallback(
    (keys: readonly string[]) => apply(() => selectAllSessions(keys), { explicit: true }),
    [apply]
  )

  const toggleAll = useCallback(
    () =>
      apply(
        (previous) =>
          visibleKeys.length > 0 && visibleKeys.every((key) => previous.selected.has(key))
            ? emptySessionSelection()
            : selectAllSessions(visibleKeys),
        { explicit: true }
      ),
    [apply, visibleKeys]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return
      }
      const mod = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // Why: Mod+Shift+Arrow is the global worktree cycle; it is not a list gesture.
        if (mod || event.altKey) {
          return
        }
        const direction = event.key === 'ArrowDown' ? 'down' : 'up'
        event.preventDefault()
        apply(
          (previous) =>
            event.shiftKey
              ? extendSessionSelection({ visibleKeys, previous, direction })
              : stepSessionSelection({ visibleKeys, previous, direction }),
          { moveFocus: true, explicit: event.shiftKey }
        )
      } else if (event.key.toLowerCase() === 'a' && mod && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        apply(() => selectAllSessions(visibleKeys), { explicit: true })
      } else if (
        event.key === 'Escape' &&
        (pruned.selected.size > 0 || useSessionSelection.getState().folderIds.size > 0)
      ) {
        event.preventDefault()
        event.stopPropagation()
        clear()
      }
    },
    [apply, clear, pruned.selected.size, visibleKeys]
  )

  return {
    selectedKeys: pruned.selected,
    focusKey: pruned.focus,
    /** Whether the selection is one a person meant as a batch, so the bulk bar should show. */
    bulk:
      shared.scope === 'visible' &&
      (pruned.selected.size > 1 || (pruned.selected.size === 1 && explicit)),
    select,
    clear,
    selectKeys,
    toggleAll,
    /** Drop the keys an action has finished with; the rest stay selected. */
    remove: useCallback(
      (keys: readonly string[]) =>
        apply(
          (previous) => {
            const selected = new Set(previous.selected)
            for (const key of keys) {
              selected.delete(key)
            }
            return selected.size === 0 ? emptySessionSelection() : { ...previous, selected }
          },
          { explicit: true }
        ),
      [apply]
    ),
    handleKeyDown
  }
}
