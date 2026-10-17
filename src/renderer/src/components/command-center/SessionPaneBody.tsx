import { SessionPaneIsland } from './SessionPaneIsland'
import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { usePaneFocus } from '../pane-focus-context'
import { NativeChatViewSwitch } from '../native-chat/NativeChatViewSwitch'
import { BorrowedSessionPaneBody } from './BorrowedSessionPaneBody'
import { NativeChatStructuredSession } from '../native-chat/NativeChatStructuredSession'
import { resolveStructuredSessionPaneTarget } from './structured-session-pane-target'

export function SessionPaneBody(props: {
  session: SidebarSession
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? (
    <div className="flex h-full min-h-0 flex-col">
      <SessionPaneIsland {...props} />
      <div className="relative min-h-0 flex-1">
        <VisibleSessionPane {...props} />
      </div>
    </div>
  ) : null
}

function VisibleSessionPane(props: {
  session: SidebarSession
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element {
  const { session } = props
  const { visible } = usePaneFocus()
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    () => true
  )
  const tab = useAppStore((state) =>
    state.unifiedTabsByWorktree[session.worktreeId]?.find((item) => item.id === session.tabId)
  )
  const tabHostId = useAppStore((state) =>
    tab ? sidebarSessionWorkspace(state, tab.worktreeId, tab.executionHostId).hostId : null
  )
  const resolved = useMemo(
    () => resolveStructuredSessionPaneTarget(session, tab, tabHostId),
    [session, tab, tabHostId]
  )
  if (session.kind === 'terminal') {
    return (
      <BorrowedSessionPaneBody
        session={session}
        onOpen={props.onOpen}
        visible={visible && windowVisible}
      />
    )
  }
  if (resolved.kind === 'chat') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end border-b px-3 py-1">
          <NativeChatViewSwitch worktreeId={session.worktreeId} unifiedTabId={resolved.tabId} />
        </div>
        <div className="relative min-h-0 flex-1">
          <NativeChatStructuredSession
            key={session.sessionKey}
            worktreeId={session.worktreeId}
            tabId={resolved.tabId}
            sessionId={resolved.sessionId}
            target={resolved.target}
            agent={session.agent}
            isVisible={visible && windowVisible}
            workRailInShell
            viewer
          />
        </div>
      </div>
    )
  }
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 bg-editor-surface p-4 text-center text-xs text-muted-foreground"
    >
      <span>
        {resolved.kind === 'missing-session'
          ? translate(
              'commandCenter.chat.missingSession',
              'This chat row is missing its session identity.'
            )
          : resolved.kind === 'identity-mismatch'
            ? translate(
                'commandCenter.chat.identityMismatch',
                'The chat tab does not match this conversation and its execution host.'
              )
            : resolved.kind === 'owner-unverifiable'
              ? translate(
                  'commandCenter.chat.ownerUnverifiable',
                  'The execution host for this conversation cannot be verified.'
                )
              : translate(
                  'commandCenter.chat.openOnOwner',
                  'This conversation must be opened on its execution computer.'
                )}
      </span>
      {resolved.kind === 'open-on-owner' ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpen(session)}>
          {translate('commandCenter.chat.openOnComputer', 'Open on that computer')}
        </Button>
      ) : null}
    </div>
  )
}
