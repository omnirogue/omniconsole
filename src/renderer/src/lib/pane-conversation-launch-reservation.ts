import { useAppStore } from '@/store'
import { createBrowserUuid } from './browser-uuid'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import { resolveTerminalCreationRoute } from '@/store/terminals/terminal-workspace-routing'
import type { reserveConversationLaunch } from './conversation-launch-draft'

/** A grid reservation is an intent, never an empty tab or a focus change. */
export function reservePaneConversationLaunch(
  input: Parameters<typeof reserveConversationLaunch>[0]
): string {
  const state = useAppStore.getState()
  resolveTerminalCreationRoute(state, input.worktreeId)
  const owner = getAgentDetectionTargetKeyForWorktree(state, input.worktreeId)
  const path = state.getKnownWorktreeById(input.worktreeId)?.path
  const id = input.submissionId ?? createBrowserUuid()
  void (async () => {
    let invoked = false
    try {
      const verified = await input.verify()
      const current = useAppStore.getState()
      if (
        !input.scopeIsCurrent() ||
        !owner ||
        owner !== getAgentDetectionTargetKeyForWorktree(current, input.worktreeId) ||
        path !== current.getKnownWorktreeById(input.worktreeId)?.path
      ) {
        throw new Error('The launch account or workspace changed. Nothing launched.')
      }
      resolveTerminalCreationRoute(current, input.worktreeId)
      invoked = true
      const result = launchAgentInNewTab({
        ...verified,
        worktreeId: input.worktreeId,
        groupId: input.groupId,
        viewModePreference: input.viewModePreference,
        tabId: id,
        submissionId: id,
        navigate: false
      })
      input.onLaunchResult?.(result)
    } catch (error) {
      input.onError?.(error, invoked)
    } finally {
      input.onSettled?.()
    }
  })()
  return id
}
