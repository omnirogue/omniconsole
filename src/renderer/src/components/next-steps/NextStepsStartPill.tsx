import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { sessionWorkOwner } from '@/components/native-chat/session-work-owner'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { useHostSeesNoTurn } from './use-host-sees-no-turn'
import { isFreshAgentStatus } from './next-steps-start-model'
import { NextStepsStartTray } from './NextStepsStartTray'

/**
 * A terminal agent that has started but not yet taken a prompt, by its own report AND the host's:
 * a small pill in the next-steps pill's top-right corner opens the workspace's suggested starts.
 */
export function NextStepsStartPill({
  worktreeId,
  tabId,
  paneKey
}: {
  worktreeId: string
  tabId: string
  paneKey: string
}) {
  const fresh = useAppStore((state) => isFreshAgentStatus(state.agentStatusByPaneKey[paneKey]))
  const agent = useAppStore((state) => state.agentStatusByPaneKey[paneKey]?.agentType)
  const sessions = useSidebarSessions('pane')
  const session = sessionWorkOwner(sessions, paneKey, tabId)
  const owned = session ? conversationSourceForSession(session) : null
  // Only the sidebar's own address for this pane, and only in this workspace.
  const ownedKey = owned && owned.worktreeId === worktreeId ? JSON.stringify(owned) : null
  const conversation = useMemo(
    () => (ownedKey ? (JSON.parse(ownedKey) as ConversationSource) : null),
    [ownedKey]
  )
  const hostFresh = useHostSeesNoTurn(fresh ? conversation : null)
  const [open, setOpen] = useState(false)
  if ((!fresh || !hostFresh || !conversation) && !open) {
    return null
  }
  return (
    <div
      className="pointer-events-none absolute top-11 right-3 z-10"
      data-next-steps-start-pill={paneKey}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="xs"
            variant="secondary"
            className="pointer-events-auto rounded-full border border-status-info-border shadow-xs"
          >
            {translate('nextStepsStart.pill', '✦ Suggested starts')}
          </Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-[28rem] max-w-[90vw] p-0">
          <NextStepsStartTray
            compact
            active={fresh && hostFresh}
            worktreeId={worktreeId}
            paneKey={paneKey}
            tabId={tabId}
            conversation={conversation}
            {...(agent ? { agent } : {})}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
