import { useAppStore } from '@/store'
import type { ConversationLaunchInput } from './conversation-launch-input'
import { resolveLaunchPlan, type LaunchPick } from './resolve-launch-plan'

export function prepareConversationReviewPick(
  input: ConversationLaunchInput,
  pick?: LaunchPick
): LaunchPick {
  const state = useAppStore.getState()
  const plan = resolveLaunchPlan({
    hasTarget: Boolean(input.worktreeId || input.company || input.defaultToWorkRoot),
    local: input.local,
    accountEnvironmentId: input.accountEnvironmentId,
    capabilities: input.readCapabilities(),
    rows: input.rows,
    pick,
    defaultProvider: state.settings?.defaultTuiAgent,
    defaults: state.settings?.conversationLaunchDefaults
  })
  return { ...pick, teamInstructions: plan.kind === 'launch' ? plan.teamInstructions : undefined }
}
