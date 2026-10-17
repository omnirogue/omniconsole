import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import { canBorrowSessionPane } from './terminal-session-pane-target'
import { resolveStructuredSessionPaneTarget } from './structured-session-pane-target'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { AgentStateDot } from '../AgentStateDot'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { usePaneFocus } from '../pane-focus-context'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import {
  useSessionActivity,
  useSessionActivityStatus
} from '../session-activity/use-session-activity'
import {
  getSessionPaneChatController,
  sessionPaneChatKey,
  subscribeSessionPaneChatController
} from '@/lib/session-pane-chat-controller'
import { canReplyToSession, sendSessionReply } from '@/lib/session-reply-send'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { translate } from '@/i18n/i18n'

export function SessionPaneIsland({
  session,
  onOpen
}: {
  session: SidebarSession
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  return enabled ? <Island session={session} onOpen={onOpen} /> : null
}
function Island({
  session,
  onOpen
}: {
  session: SidebarSession
  onOpen: (session: SidebarSession) => void
}): React.JSX.Element {
  const statusKey = sidebarSessionStatusKey(session)
  const status = useSessionActivityStatus(statusKey)
  const activity = useSessionActivity({ paneKey: statusKey })
  const tab = useAppStore((state) =>
    state.unifiedTabsByWorktree[session.worktreeId]?.find(
      (entry) =>
        entry.id === session.tabId ||
        (entry.contentType === 'terminal' && entry.entityId === session.tabId)
    )
  )
  const tabHostId = useAppStore((state) =>
    tab ? sidebarSessionWorkspace(state, tab.worktreeId, tab.executionHostId).hostId : null
  )
  const owned =
    session.kind === 'structured'
      ? resolveStructuredSessionPaneTarget(session, tab, tabHostId).kind === 'chat'
      : canBorrowSessionPane(session, tab, tabHostId)
  const key = sessionPaneChatKey(session.hostId, session.worktreeId, tab?.id ?? session.tabId ?? '')
  const subscribe = useCallback(
    (listener: () => void) => subscribeSessionPaneChatController(key, listener),
    [key]
  )
  const getSnapshot = useCallback(() => getSessionPaneChatController(key), [key])
  const chat = useSyncExternalStore(subscribe, getSnapshot, () => null)
  const { visible } = usePaneFocus()
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    () => true
  )
  const structured = session.kind === 'structured' || Boolean(tab?.structuredSessionId)
  const writable =
    visible &&
    windowVisible &&
    !session.unavailable &&
    owned &&
    (structured ? chat?.writable === true : canReplyToSession(session))
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsYou =
    chat?.needsYou ?? (status?.state === 'blocked' || status?.state === 'waiting' ? 1 : 0)
  const messages = chat
    ? chat.messages
        .slice(-3)
        .map((message) => ({
          id: message.id,
          text: message.blocks
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n')
        }))
        .filter((message) => message.text)
    : [
        { id: 'completed', text: status?.lastCompletedAssistantMessage },
        { id: 'current', text: status?.lastAssistantMessage }
      ].filter((message): message is { id: string; text: string } => Boolean(message.text))
  const send = async (): Promise<void> => {
    if (!writable || sending || !draft.trim()) {
      return
    }
    setSending(true)
    setError(null)
    try {
      if (structured) {
        if (!chat?.send(draft.trim())) {
          throw new Error('This viewer cannot send yet. Resume the session before replying.')
        }
      } else {
        await sendSessionReply(session, draft.trim())
      }
      setDraft('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="shrink-0 border-b bg-background px-2 py-1">
      <div className="flex justify-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={translate('commandCenter.island.label', 'Session status')}
          onClick={() => setExpanded((value) => !value)}
          className="flex max-w-full items-center gap-1.5 rounded-full border bg-muted/30 px-2 py-1 text-xs"
        >
          <AgentStateDot state={status?.state ?? 'idle'} size="sm" title={null} />
          <AgentIcon agent={agentTypeToIconAgent(session.agent)} size={14} />
          <span className="truncate">{activity.line}</span>
          <span className="shrink-0">
            {translate('commandCenter.island.needsYou', '{{count}} needs you', { count: needsYou })}
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="space-y-2 p-2">
          <div className="max-h-40 overflow-y-auto scrollbar-sleek text-xs text-muted-foreground">
            {messages.length ? (
              messages.map((message) => (
                <p key={message.id} className="mb-2 whitespace-pre-wrap break-words">
                  {message.text}
                </p>
              ))
            ) : (
              <p>{translate('commandCenter.island.noMessages', 'No recent messages available.')}</p>
            )}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <Input
              aria-label={translate('commandCenter.island.reply', 'Quick reply')}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!writable || sending}
              className="h-8"
            />
            <Button type="submit" size="xs" disabled={!writable || sending || !draft.trim()}>
              {translate('commandCenter.island.send', 'Send')}
            </Button>
          </form>
          {!writable ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'commandCenter.island.readOnly',
                'Reply is unavailable while this viewer is read-only or paused. Use Resume in the chat to continue.'
              )}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => onOpen(session)}>
            {translate('commandCenter.island.openFull', 'Open full view')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
