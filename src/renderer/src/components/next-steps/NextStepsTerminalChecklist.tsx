import { ChevronUp, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { ConversationSource } from '../../../../shared/conversation-source'
import { useAppStore } from '@/store'
import {
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId
} from '@/lib/sidebar-session-on-screen'
import { requestSessionPanelView } from '@/components/right-sidebar/session-artifact/session-panel-view-request'
import { NextStepsTray } from './NextStepsTray'

/**
 * A menu the session offered, shown open in the terminal's top-right corner so it cannot be
 * missed: the tray's checklist, the named options ticked, "Build selected" sending the ticked ones
 * as one message. It scrolls inside at most half the pane, clear of the agent's input box and
 * permission prompts, and collapses back to the pill.
 */
export function NextStepsTerminalChecklist({
  tabId,
  paneKey,
  conversation,
  count,
  onCollapse
}: {
  tabId: string
  paneKey: string
  conversation: ConversationSource
  count: number
  onCollapse: () => void
}) {
  // The right panel shows the conversation on screen; offer it only for this pane.
  const onScreen = useAppStore(
    (state) =>
      selectOnScreenSessionTabId(state) === tabId &&
      selectOnScreenSessionLeafId(state) === parsePaneKey(paneKey)?.leafId
  )
  return (
    <div
      className="pointer-events-auto flex min-h-0 w-[28rem] max-w-full flex-col overflow-hidden rounded-md border border-status-info-border bg-background shadow-md"
      data-next-steps-checklist={paneKey}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-status-info-border py-1 pr-1 pl-3 text-xs font-medium">
        <span className="min-w-0 flex-1 truncate">
          {translate('nextSteps.checklist.title', '✦ The session offered {{n}} options', {
            n: count
          })}
        </span>
        {onScreen ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={translate('nextSteps.checklist.openInPanel', 'Open in the side panel')}
            title={translate('nextSteps.checklist.openInPanel', 'Open in the side panel')}
            onClick={() => requestSessionPanelView('next-steps')}
          >
            <PanelRight />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={translate('nextSteps.checklist.collapse', 'Collapse to the pill')}
          title={translate('nextSteps.checklist.collapse', 'Collapse to the pill')}
          onClick={onCollapse}
        >
          <ChevronUp />
        </Button>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <NextStepsTray
          compact
          paneKey={paneKey}
          tabId={tabId}
          conversation={conversation}
          disabled={false}
        />
      </div>
    </div>
  )
}
