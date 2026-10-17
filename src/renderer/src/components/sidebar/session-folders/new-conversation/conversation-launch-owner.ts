import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import type { ConversationLaunchInput } from './conversation-launch-input'

/** Async discovery cannot dispatch after the user chooses a different computer or workspace. */
export function captureConversationLaunchOwner(
  input: ConversationLaunchInput,
  readLatest: () => ConversationLaunchInput
): () => boolean {
  const focusedRuntime = useAppStore.getState().settings?.activeRuntimeEnvironmentId
  return () => {
    const state = useAppStore.getState()
    const latest = readLatest()
    return (
      selectConsoleAccountScope(state) === input.scope &&
      state.settings?.activeRuntimeEnvironmentId === focusedRuntime &&
      latest.worktreeId === input.worktreeId &&
      latest.accountEnvironmentId === input.accountEnvironmentId
    )
  }
}

export function assertCurrentConversationLaunchOwner(scopeIsCurrent: () => boolean): void {
  if (!scopeIsCurrent()) {
    throw new Error(
      translate(
        'computerPicker.launchHostChanged',
        'The selected computer changed. Reopen the launcher to start there.'
      )
    )
  }
}
