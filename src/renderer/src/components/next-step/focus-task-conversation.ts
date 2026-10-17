import { useAppStore } from '@/store'
import { workflowData } from '@/lib/console-workflow-client'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  findTerminalHandleTarget,
  focusRendererTerminalHandle
} from '@/components/terminal-pane/terminal-handle-links'
import {
  findUnifiedTabIdForTerminalTab,
  resolveNativeChatTabToggle
} from '@/components/native-chat/native-chat-tab-toggle'
import type { ConsoleLocalExecutionView } from '../../../../shared/console-local-execution'

/**
 * Shows the conversation "Start agent" just created. It is a new tab, so opening it in Chat
 * does not override a mode the person chose for an existing conversation.
 */
export async function focusTaskConversation(execution: ConsoleLocalExecutionView): Promise<void> {
  activateAndRevealWorkspace(execution.worktreeId, { providesInitialSurface: true })
  if (!execution.terminalHandle || !focusRendererTerminalHandle(execution.terminalHandle, null)) {
    const api = window.api.consoleLocalExecution
    if (!api) {
      throw new Error('Local execution navigation is unavailable.')
    }
    workflowData(await api.focus({ jobId: execution.jobId }))
  }
  const state = useAppStore.getState()
  const target = execution.terminalHandle
    ? findTerminalHandleTarget(execution.terminalHandle, state, null)
    : null
  const tabId = target
    ? findUnifiedTabIdForTerminalTab(state, target.worktreeId, target.tabId)
    : null
  if (target && tabId && resolveNativeChatTabToggle(state, target.worktreeId, tabId)?.eligible) {
    state.setTabViewMode(tabId, 'chat')
  }
}
