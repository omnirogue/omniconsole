import React, { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { AttentionTerminalSlot } from '../attention/AttentionTerminalSlot'
import {
  useSessionGridTerminalPortals,
  type SessionGridTerminalSlot
} from '../session-grid/use-session-grid-portals'

const PROJECT_CHAT_PANE_ID = 'project-chat'

/**
 * The project's chat beside its threads: the coordinator's live pane borrowed from its tab the
 * way the Grid borrows panes (plan: Project chat, Phase 4), so there is no second PTY or chat
 * view. The tab stays the pane's home; "Open in tab" goes there.
 */
export function SessionProjectChatPane({
  thread,
  activeWorktreeId
}: {
  thread: SessionProjectThread
  activeWorktreeId: string | null
}): React.JSX.Element {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const session = thread.row.session
  const slots = useMemo<SessionGridTerminalSlot[]>(
    () => (target ? [{ paneId: PROJECT_CHAT_PANE_ID, session, target }] : []),
    [target, session]
  )
  useSessionGridTerminalPortals(slots, PROJECT_CHAT_PANE_ID, activeWorktreeId, 'project')
  return (
    <aside
      data-session-project-chat-pane={session.rowKey}
      className="flex w-[26rem] shrink-0 flex-col border-l"
    >
      <AttentionTerminalSlot
        slotId={PROJECT_CHAT_PANE_ID}
        label={translate('projects.chat.pane', 'Project chat')}
        focused
        onFocusSlot={() => undefined}
        pane={{ paneKey: null }}
        target={target}
        setTarget={setTarget}
        header={
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold leading-snug">
                {translate('projects.chat.pane', 'Project chat')}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {isTuiAgent(thread.agent) ? getAgentLabel(thread.agent) : thread.agent}
              </div>
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openSidebarSession(session)}
              aria-label={translate('projects.chat.openTab', 'Open in tab')}
              title={translate('projects.chat.openTab', 'Open in tab')}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </div>
        }
        empty={null}
      />
    </aside>
  )
}
