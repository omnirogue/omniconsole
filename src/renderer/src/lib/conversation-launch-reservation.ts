import type { AppState } from '@/store'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-types'

export function conversationLaunchReservationIsCurrent(
  state: Pick<AppState, 'tabsByWorktree'>,
  {
    worktreeId,
    reservedConversationTabId
  }: Pick<LaunchAgentInNewTabArgs, 'worktreeId' | 'reservedConversationTabId'>
): boolean {
  return (
    !reservedConversationTabId ||
    state.tabsByWorktree[worktreeId]?.some(
      (tab) => tab.id === reservedConversationTabId && tab.conversationLaunchPending
    ) === true
  )
}
