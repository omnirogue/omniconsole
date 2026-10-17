import { useAppStore } from '@/store'
import { resolveTerminalHostOwnership } from '@/lib/terminal-worktree-route'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { guardPinnedTabClose, shouldConfirmPinnedTabClose } from '@/store/pinned-tab-close-guard'
import { routineConversationClosed } from '../sidebar/routines/close-routine-conversation'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import type { TerminalTabCloseOptions } from './terminal-tab-close-options'

/** Native chats have no terminal entity; all user close paths share their host retirement. */
export function closeStructuredAgentTab(tabId: string, options?: TerminalTabCloseOptions): boolean {
  const state = useAppStore.getState()
  const found = Object.entries(state.unifiedTabsByWorktree ?? {}).flatMap(([worktreeId, tabs]) =>
    tabs
      .filter(
        (tab) => tab.contentType === 'agent-session' && (tab.id === tabId || tab.entityId === tabId)
      )
      .map((tab) => ({ worktreeId, tab }))
  )[0]
  if (!found) {
    return false
  }
  const { worktreeId, tab } = found
  const route = resolveTerminalHostOwnership(state, worktreeId, 'teardown')
  if (route.kind === 'unresolved' || options?.reason === 'pty-exit') {
    options?.onCancel?.()
    return true
  }
  if (tab.isPinned && !options?.force) {
    if (options?.rejectPinned) {
      options.onCancel?.()
      return true
    }
    if (shouldConfirmPinnedTabClose(state)) {
      guardPinnedTabClose({
        isPinned: true,
        tabLabel: tab.customLabel ?? tab.label,
        onClose: () => closeStructuredAgentTab(tabId, { ...options, force: true }),
        ...(options?.onCancel ? { onCancel: options.onCancel } : {})
      })
      return true
    }
  }
  const target = route.runtimeEnvironmentId
    ? ({ kind: 'environment', environmentId: route.runtimeEnvironmentId } as const)
    : ({ kind: 'local' } as const)
  const hostId = route.runtimeEnvironmentId
    ? toRuntimeExecutionHostId(route.runtimeEnvironmentId)
    : getResolvedExecutionHostIdForWorktree(state, worktreeId)
  void closeStructuredAgentSession(target, tab.entityId)
    .then((result) => {
      if (result !== 'closed') {
        throw new Error(
          translate(
            'components.native-chat.structuredSessionCloseFailed',
            'Could not close this Codex chat'
          )
        )
      }
      return callRuntimeRpc(target, 'session.tabs.close', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        tabId: `agent-session:${tab.entityId}`,
        reason: options?.reason ?? options?.hostCloseReason ?? 'user'
      })
    })
    .then(() => {
      useAppStore.getState().closeUnifiedTab(tab.id)
      routineConversationClosed(tab.id, hostId)
      options?.onClosed?.()
    })
    .catch((error) => {
      toast.error(
        translate(
          'components.native-chat.structuredSessionCloseFailed',
          'Could not close this Codex chat'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
      options?.onCancel?.()
    })
  return true
}
