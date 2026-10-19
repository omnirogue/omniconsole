import { useAppStore } from '@/store'
import { isSessionGridView } from '@/lib/command-center-navigation'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { focusSessionInGrid } from '@/lib/session-grid-actions'
import { waitLaterKeyForPane } from '@/lib/wait-later'
import { useWaitLater } from '@/store/wait-later-store'
import { cancelQueuedSession } from './session-queue-state'

export function openSessionRow(session: SidebarSession): void {
  // Opening the row acknowledges a result handed back to the person.
  if (session.paneKey) {
    useWaitLater.getState().setReturned(waitLaterKeyForPane(session.paneKey), null)
  }
  const state = useAppStore.getState()
  if (
    !isSessionGridView(state.activeView, state.settings?.commandCenter) ||
    !focusSessionInGrid(session)
  ) {
    openSidebarSession(session)
  }
}

export function cancelSessionRowQueue(session: SidebarSession): void {
  cancelQueuedSession(session.rowKey)
  toast.success(
    translate('auto.components.SessionSidebar.queueCancelled', 'Queued session cancelled.')
  )
}

export async function retainWorkerAsConversation(params: {
  workerDispatchId: string
  workerProcessIncarnation: string
  paneKey: string
}): Promise<void> {
  try {
    const result = await callRuntimeRpc<{
      dispatchId: string
      state: string
      reason?: string
    }>({ kind: 'local' }, 'orchestration.workerRetain', {
      dispatch: params.workerDispatchId,
      expectedPaneKey: params.paneKey,
      expectedProcessIncarnation: params.workerProcessIncarnation
    })
    if (
      result.dispatchId !== params.workerDispatchId ||
      result.state !== 'retained' ||
      result.reason !== 'user_requested'
    ) {
      toast(
        translate(
          'conversations.keepWorkerStale',
          'This worker identity changed. Refresh and try again.'
        )
      )
      return
    }
    toast(translate('conversations.keepWorkerSuccess', 'Worker kept as a conversation.'))
    window.dispatchEvent(new Event('omni.worker-lineage-refresh'))
  } catch {
    toast(
      translate(
        'conversations.keepWorkerFailure',
        'Could not keep this worker as a conversation. Check its current ownership state.'
      )
    )
  }
}
