import { useEffect, useId, useLayoutEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { usePaneFocus } from '../pane-focus-context'
import { setActivityTerminalPortals } from '../activity/activity-terminal-portal'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/background-terminal-worktree-mount'
import { canBorrowSessionPane } from './terminal-session-pane-target'

/** Borrow the whole main tab, including its shared Chat / Terminal switch. */
export function BorrowedSessionPaneBody(props: {
  session: SidebarSession
  visible?: boolean
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element {
  const { session } = props
  const owner = `session-pane:${useId()}`
  const { visible: paneVisible, focused } = usePaneFocus()
  const visible = paneVisible && props.visible !== false
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const { tab, hostId } = useAppStore(
    useShallow((state) => {
      const tab = state.unifiedTabsByWorktree[session.worktreeId]?.find(
        (item) => item.contentType === 'terminal' && item.entityId === session.tabId
      )
      return {
        tab,
        hostId: tab
          ? sidebarSessionWorkspace(state, tab.worktreeId, tab.executionHostId).hostId
          : null
      }
    })
  )
  const borrow = canBorrowSessionPane(session, tab, hostId)
  const descriptors = useMemo(
    () =>
      target && borrow
        ? [
            {
              slotId: owner,
              requestToken: `${owner}:${session.tabId}`,
              target,
              worktreeId: session.worktreeId,
              tabId: session.tabId!,
              paneKey: '',
              mounted: true,
              visible,
              focused,
              active: focused,
              passiveViewer: true
            }
          ]
        : [],
    [target, borrow, owner, session.worktreeId, session.tabId, visible, focused]
  )
  useLayoutEffect(() => setActivityTerminalPortals(descriptors, owner), [descriptors, owner])
  useEffect(() => () => setActivityTerminalPortals([], owner), [owner])
  useEffect(() => {
    if (borrow && visible && session.tabId) {
      requestBackgroundTerminalWorktreeMount({
        worktreeId: session.worktreeId,
        tabIds: [session.tabId]
      })
    }
  }, [borrow, visible, session.worktreeId, session.tabId])
  return borrow ? (
    <div ref={setTarget} className="absolute inset-0 min-h-0 min-w-0" />
  ) : (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground"
    >
      <span>
        {translate(
          'commandCenter.chat.openOnOwner',
          'This conversation must be opened on its execution computer.'
        )}
      </span>
      <Button size="xs" variant="outline" onClick={() => props.onOpen(session)}>
        {translate('commandCenter.chat.openOnComputer', 'Open on that computer')}
      </Button>
    </div>
  )
}
