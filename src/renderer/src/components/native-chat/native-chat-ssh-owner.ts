import { getConnectionIdFromState } from '@/lib/connection-context'
import type { AppState } from '@/store/types'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

export function selectSshOmpChatOwner(
  state: Parameters<typeof getConnectionIdFromState>[0] & Pick<AppState, 'tabsByWorktree'>,
  agent: string,
  terminalTabId?: string,
  runtimeEnvironmentId?: string | null
): string | null {
  if (agent !== 'omp' || runtimeEnvironmentId) {
    return null
  }
  const workspaceId = terminalTabId
    ? findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
    : null
  const connection = workspaceId ? getConnectionIdFromState(state, workspaceId) : undefined
  // An unresolved owner must never select the local transcript reader.
  if (connection === undefined) {
    return 'unresolved-ssh-transcript-owner'
  }
  return connection && !isRuntimeOwnedSshTargetId(connection) ? connection : null
}
