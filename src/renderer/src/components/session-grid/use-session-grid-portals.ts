import { useEffect, useLayoutEffect, useMemo } from 'react'
import {
  setActivityTerminalPortals,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/background-terminal-worktree-mount'
import type { SidebarSession } from '@/lib/sidebar-sessions'

export type SessionGridTerminalSlot = {
  paneId: string
  session: SidebarSession
  target: HTMLElement
  visible?: boolean
}

/** A pane can borrow a conversation's live terminal only while its tab is open. */
export function canShowSessionTerminal(session: SidebarSession | null): boolean {
  return Boolean(session && session.kind === 'terminal' && session.tabId && !session.unavailable)
}

/**
 * Borrows each pane's live terminal out of the hidden workbench (the Attention mechanism, so no
 * second PTY or xterm). Why the whole tab (empty paneKey): one TerminalPane serves a tab, so a
 * tab split inside shows whole, as it does in its workspace.
 */
export function useSessionGridTerminalPortals(
  slots: readonly SessionGridTerminalSlot[],
  focusedPaneId: string | null,
  activeWorktreeId: string | null,
  owner = 'grid',
  maximizedPaneId: string | null = null
): void {
  const descriptors = useMemo<ActivityTerminalPortalTarget[]>(
    () =>
      slots.map(({ paneId, session, target, visible = true }) => ({
        slotId: `grid:${paneId}`,
        requestToken: `grid:${paneId}:${session.tabId}`,
        target,
        worktreeId: session.worktreeId,
        tabId: session.tabId!,
        paneKey: '',
        mounted: true,
        visible: visible && (maximizedPaneId === null || paneId === maximizedPaneId),
        focused: paneId === focusedPaneId,
        active: paneId === focusedPaneId
      })),
    [slots, focusedPaneId, maximizedPaneId]
  )

  // Why useLayoutEffect: publish before paint so Terminal's portal subscriber rerenders in the same commit.
  useLayoutEffect(() => {
    setActivityTerminalPortals(descriptors, owner)
  }, [descriptors, owner])

  // Why only on unmount: clearing per change would flash the workspace pane behind a slot.
  useEffect(() => () => setActivityTerminalPortals([], owner), [owner])

  const mounts = useMemo(() => {
    const byWorktree = new Map<string, string[]>()
    for (const { session } of slots) {
      if (session.worktreeId !== activeWorktreeId && session.tabId) {
        byWorktree.set(session.worktreeId, [
          ...(byWorktree.get(session.worktreeId) ?? []),
          session.tabId
        ])
      }
    }
    return JSON.stringify([...byWorktree])
  }, [slots, activeWorktreeId])

  useEffect(() => {
    // Why: a workspace not opened this run has no mounted panes; a targeted mount lets it render here.
    for (const [worktreeId, tabIds] of JSON.parse(mounts) as [string, string[]][]) {
      requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds })
    }
  }, [mounts])
}
