import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'

/** Share the committed transition and telemetry with legacy store callers. */
export function commitNativeChatViewMode(
  state: AppState,
  worktreeId: string,
  tab: Tab,
  mode: 'chat' | 'terminal',
  emitTelemetry = true
): void {
  const from = tab.viewMode ?? 'terminal'
  state.setTabViewMode(tab.id, mode)
  if (emitTelemetry && from !== mode) {
    const agent =
      state.tabsByWorktree[worktreeId]?.find((terminal) => terminal.id === tab.entityId)
        ?.launchAgent ?? null
    emitNativeChatToggled({ from, to: mode, agent })
  }
}
