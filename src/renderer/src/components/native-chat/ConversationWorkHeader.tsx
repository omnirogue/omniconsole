import { RoutineCreationNotice } from '@/components/sidebar/routines/RoutineCreationNotice'
import { RoutineConversationHeader } from '@/components/sidebar/routines/RoutineConversationHeader'
import { useRoutineForTab } from '@/components/sidebar/routines/routine-conversation-state'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { PromptQueueStrip } from '@/components/prompt-queue/PromptQueueStrip'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import { conversationViewKey } from '@/lib/conversation-view'
import { useAppStore } from '@/store'
import { NativeChatViewSwitch } from './NativeChatViewSwitch'
import { getCachedUnifiedTerminalTabForWorktree } from '../terminal-pane/terminal-unified-tab-lookup'
import { sessionWorkOwner } from './session-work-owner'
import { ConversationInformation } from './ConversationInformation'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/**
 * Reuses the same work actions and owning session shown in Work and the sidebar, and carries
 * the conversation's own Chat / Terminal switch on its title line (Sal, 2026-09-18: the switch
 * belongs to each conversation, not to the window's top-right corner).
 */
export function ConversationWorkHeader({
  worktreeId,
  paneKey,
  tabId,
  messages
}: {
  worktreeId: string
  paneKey: string
  tabId: string
  /** The transcript the chat view already assembled; reused for tasks and context. */
  messages?: readonly NativeChatMessage[]
}) {
  const unifiedTabId = useAppStore(
    (state) =>
      getCachedUnifiedTerminalTabForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId)?.id ??
      tabId
  )
  const sessions = useSidebarSessions('pane')
  const session = sessionWorkOwner(sessions, paneKey, tabId)
  // A routine keeps running on its schedule: it has no next step to hand to an
  // agent or a person, so its conversation does not carry the Up next chain.
  const isRoutineConversation = Boolean(useRoutineForTab(tabId, paneKey))
  const viewSwitch = (
    <NativeChatViewSwitch
      worktreeId={worktreeId}
      unifiedTabId={unifiedTabId}
      terminalTabId={tabId}
      paneKey={paneKey}
    />
  )
  return (
    <>
      <RoutineCreationNotice session={session} />
      <RoutineConversationHeader tabId={tabId} paneKey={paneKey} />
      <div className="border-b" data-conversation-work-header data-conversation-tab-id={tabId}>
        {session ? (
          <ConversationInformation
            key={conversationViewKey(session)}
            session={session}
            trailing={viewSwitch}
            messages={messages}
            showOutcome={!isRoutineConversation}
          />
        ) : (
          <div
            className="flex h-9 items-center justify-end gap-2 px-3 text-xs font-medium"
            data-conversation-header-row=""
            style={{
              paddingRight: 'calc(var(--pane-header-action-gutter, 0px) + var(--spacing) * 3)'
            }}
          >
            <div className="shrink-0">{viewSwitch}</div>
          </div>
        )}
        {session ? <PromptQueueStrip source={conversationSourceForSession(session)} /> : null}
      </div>
    </>
  )
}
