import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { localWorkflowStatusUnverified } from '@/lib/local-workflow-tab-status'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'

/**
 * The row menu's "Check status again" for a workflow whose run was not found or whose status
 * could not be read: the same bounded re-arm a reconnect or window focus starts, for this row.
 */
export function SessionWorkflowRecheckMenuItem({
  session,
  onDone
}: {
  session: SidebarSession
  onDone: () => void
}): React.JSX.Element | null {
  const status = session.workflow?.status
  if (!session.tabId || status === 'unknown' || !localWorkflowStatusUnverified(status)) {
    return null
  }
  const tabId = session.tabId
  return (
    <Button
      variant="ghost"
      size="xs"
      role="menuitem"
      className="w-full justify-start gap-2"
      data-session-row-workflow-recheck=""
      onClick={() => {
        onDone()
        useAppStore.getState().refreshLocalWorkflowStatuses(tabId)
      }}
    >
      <RefreshCw className="size-3.5" />
      {translate('conversations.workflowRecheck', 'Check status again')}
    </Button>
  )
}
