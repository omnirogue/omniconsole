import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentOutcome
} from '@/lib/launch-agent-in-new-tab-types'
import { getOrcaCliCommandNameForPlatform } from '../../../shared/omni-cli-command-name'
import { prependNextOutcomeTeamPlan } from '../../../shared/next-outcome-team-plan-instructions'
import { prependHubTaskPrompt } from '../../../shared/omnios-task-binding'

/**
 * What a launch submits: the outcome as a plain goal line and any typed prompt, bound to the chosen
 * task. One text for every delivery path. Next steps are set through the UI, so a plain outcome
 * launch carries no outcome-binding instruction; only the user's explicit "Plan the team" consent
 * still adds the team-planning instruction, which that feature needs to run.
 */
export function composeLaunchAgentPrompt(args: {
  prompt: string
  outcome?: LaunchAgentOutcome | null
  hubTaskId?: string | null
  platform: NodeJS.Platform
  isRemote: boolean
}): string {
  const outcome = args.outcome?.text.trim()
  const consentedAt = outcome ? args.outcome?.teamPlanConsentedAt : undefined
  // The team-planning instruction names "the outcome below", so that variant keeps it bare.
  const goal = outcome && !consentedAt ? `Goal: ${outcome}` : outcome
  const text = [goal, args.prompt.trim()].filter(Boolean).join('\n\n')
  const bound = args.hubTaskId ? prependHubTaskPrompt(text, args.hubTaskId).trim() : text
  if (!consentedAt) {
    return bound
  }
  const cli = args.isRemote ? 'omni' : getOrcaCliCommandNameForPlatform(args.platform)
  return prependNextOutcomeTeamPlan(bound, cli, consentedAt)
}

/** The trimmed prompt a new-tab launch delivers for its typed prompt, outcome and parent task. */
export function launchAgentPrompt(
  args: Pick<LaunchAgentInNewTabArgs, 'prompt' | 'outcome' | 'hubTaskId'>,
  platform: NodeJS.Platform,
  isRemote: boolean
): string {
  return composeLaunchAgentPrompt({
    prompt: args.prompt ?? '',
    outcome: args.outcome,
    hubTaskId: args.hubTaskId,
    platform,
    isRemote
  }).trim()
}
