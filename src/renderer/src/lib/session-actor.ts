import { assertOpenRouterRoute } from '../../../shared/openrouter-route'
import type { AgentLaunchPreferenceSelection } from '../../../shared/agent-launch-preference-check'
import { resolveAgentAccountLaunchEnv } from '../../../shared/agent-account-profiles'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The person's actor choice for one launch: model, effort and which account the
 * CLI starts under. The agent itself travels beside it because the ids only mean
 * something for that agent.
 */
export type SessionActorSelection = {
  model?: string
  openrouterCandidates?: string[]
  effort?: string
  /** `managed:<id>` / `profile:<id>` from listAgentAccountChoices; null for the current sign-in. */
  accountChoiceId?: string | null
}

export const EMPTY_SESSION_ACTOR: SessionActorSelection = {}

export type ResolvedSessionActorLaunch = {
  launchPreferences: AgentLaunchPreferenceSelection | null
  launchEnv: Record<string, string> | null
}

/** Turn an actor choice into the launch inputs the continuation path understands. */
export function resolveSessionActorLaunch(
  settings:
    | Pick<
        GlobalSettings,
        'claudeManagedAccounts' | 'codexManagedAccounts' | 'agentAccountProfiles'
      >
    | null
    | undefined,
  agent: TuiAgent,
  actor: SessionActorSelection | null | undefined
): ResolvedSessionActorLaunch {
  assertOpenRouterRoute({ agent, ...actor })
  const model = actor?.model?.trim()
  const effort = actor?.effort?.trim()
  const launchPreferences = model
    ? {
        ...(actor?.openrouterCandidates !== undefined
          ? { openrouterCandidates: [...actor.openrouterCandidates] }
          : {}),
        model,
        ...(effort ? { effort } : {})
      }
    : null
  const launchEnv = resolveAgentAccountLaunchEnv(settings, agent, actor?.accountChoiceId) ?? null
  return { launchPreferences, launchEnv }
}
