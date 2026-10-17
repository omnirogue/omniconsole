import type { SidebarSession } from './sidebar-sessions'
import type { SessionSidebarView } from './session-sidebar-view'

export function conversationViewKey(
  session: Pick<SidebarSession, 'sessionKey' | 'rowKey'>
): string {
  return session.sessionKey ?? session.rowKey
}

/**
 * Whether the person deleted this row's conversation, so every list built from the sidebar's rows
 * leaves it out (`deleted`: the view's deletion marks). Why the tab: a deleted conversation leaves
 * the list for good; one whose tab is open again comes back.
 */
export function isSessionRowDeleted(
  deleted: ReadonlySet<string>,
  session: Pick<SidebarSession, 'tabId' | 'sessionKey' | 'rowKey'>
): boolean {
  return !session.tabId && deleted.has(conversationViewKey(session))
}

export function conversationWaitKey(session: SidebarSession): string {
  return session.paneKey
    ? `pane:${session.paneKey}`
    : `conversation:${conversationViewKey(session)}`
}

/**
 * Whether a personally hidden row leaves the list right now. Why (Sal, 2026-09-23, asked many
 * times): a conversation whose tab is open is always listed. The hide mark stays and takes the row
 * to Hidden once its tab is closed, the same way a deleted row comes back while its tab is open.
 */
export function isPersonalRowHiddenNow(view: SessionSidebarView, session: SidebarSession): boolean {
  return !session.tabId && isPersonalRowHidden(view, session)
}

export function isPersonalRowHidden(
  view: Pick<SessionSidebarView, 'hidden'>,
  session: Pick<SidebarSession, 'sessionKey' | 'rowKey'>,
  list = 'conversation'
): boolean {
  const key = conversationViewKey(session)
  return (
    view.hidden.includes(`${list}:${key}`) ||
    ((list === 'conversation' || list === 'session') &&
      (view.hidden.includes(`conversation:${key}`) || view.hidden.includes(`session:${key}`)))
  )
}
