import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationSource } from '../../../../../shared/conversation-source'
import { NextStepsTray } from '@/components/next-steps/NextStepsTray'
import { usePendingNextStepCount } from '@/components/next-steps/next-steps-pending-store'
import { SessionWaits } from './SessionWaits'

/**
 * The right panel's Next steps view: the same tray the chat view shows, for the conversation on
 * screen, so a menu the reply offered can be ticked and built from beside the terminal too.
 */
export function SessionNextSteps({
  session,
  visible
}: {
  session: SidebarSession
  visible: boolean
}) {
  const address = conversationSourceForSession(session)
  const addressKey = address ? JSON.stringify(address) : null
  const conversation = useMemo(
    () => (addressKey ? (JSON.parse(addressKey) as ConversationSource) : null),
    [addressKey]
  )
  const count = usePendingNextStepCount(conversation)
  const { tabId } = session
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-3" data-session-next-steps>
      <p className="mb-3 truncate text-xs font-medium" title={session.label}>
        {session.label}
      </p>
      {conversation && tabId ? (
        <NextStepsTray
          compact
          paneKey={conversation.paneKey}
          tabId={tabId}
          conversation={conversation}
          disabled={false}
          visible={visible}
        />
      ) : null}
      {!conversation || !tabId || count === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {translate('sessionPanel.noNextSteps', 'No suggestions for this turn.')}
        </p>
      ) : null}
      <SessionWaits session={session} visible={visible} />
    </div>
  )
}
