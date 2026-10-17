import { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers,
  type CommitMessageAgentRuntimeTarget
} from './commit-message-agent-environment'
import { planModelDiscovery } from './commit-message-model-discovery-policy'
import { activeModelDiscoveryCache, type ModelDiscoveryRefresh } from './model-discovery-cache'
import { quietBackgroundAgentPlan } from './quiet-background-runs'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'

/** Why thrown: an account that could not be set up is reported, never kept as a listing. */
class AccountSetupFailure extends Error {}

/**
 * The listing a host CLI would run (quiet recipe included), or null when it runs none. Why the
 * backslash mode inline: `commandBackslashMode` for a local, non-WSL target, without loading the
 * generation runner just to key a lookup.
 */
function hostListingPlan(
  agentId: TuiAgent,
  agentCommandOverride: string | undefined
): CommitMessagePlan | null {
  const spec = getAgentModelProbeSpec(agentId)
  if (!spec || spec.modelSource === 'static' || !spec.modelDiscovery) {
    return null
  }
  const backslash = process.platform === 'win32' ? 'literal' : 'escape'
  const planned = planModelDiscovery(spec, agentCommandOverride, backslash)
  return planned.ok
    ? quietBackgroundAgentPlan(agentId, planned.plan, 'model-discovery', { remote: false })
    : null
}

/** The selected account a host listing is filed under; undefined when it is not looked up first. */
function listingAccount(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target: CommitMessageAgentRuntimeTarget
): string | null | undefined {
  if (target.runtime === 'wsl' || (agentId !== 'claude' && agentId !== 'codex')) {
    return undefined
  }
  return resolvers?.listingAccount?.(agentId, target)
}

/**
 * A model listing on this host with the agent's account set up only when the listing must run.
 * Why: a Claude or Codex account setup refreshes usage, balances seats, reads the keychain and
 * syncs seat files, and every launcher opening asks for each detected agent's listing. While quiet
 * background runs are on, a Claude or Codex listing is looked up by the account settings select
 * first; WSL, other agents and resolvers without that reader set up first, as before. `list` runs
 * the listing (and any route check) in the prepared environment.
 */
export async function discoverLocalModelsWithAccount(
  input: {
    agentId: string
    agentCommandOverride: string | undefined
    resolvers: CommitMessageAgentEnvironmentResolvers | undefined
    target: CommitMessageAgentRuntimeTarget
    refresh?: ModelDiscoveryRefresh
  },
  list: (env: NodeJS.ProcessEnv | undefined) => Promise<DiscoverCommitMessageModelsResult>
): Promise<DiscoverCommitMessageModelsResult> {
  const setUpAndList = async (): Promise<DiscoverCommitMessageModelsResult> => {
    const prepared = await prepareLocalCommitMessageAgentEnv(
      input.agentId,
      input.resolvers,
      input.target
    )
    if (!prepared.ok) {
      throw new AccountSetupFailure(prepared.error)
    }
    return list(prepared.env)
  }
  const cache = activeModelDiscoveryCache()
  const account = cache ? listingAccount(input.agentId, input.resolvers, input.target) : undefined
  const plan =
    account === undefined
      ? null
      : hostListingPlan(input.agentId as TuiAgent, input.agentCommandOverride)
  try {
    return cache && plan && account !== undefined
      ? await cache.runForAccount(
          { agentId: input.agentId, plan, account, force: input.refresh?.force },
          setUpAndList
        )
      : await setUpAndList()
  } catch (error) {
    if (error instanceof AccountSetupFailure) {
      return { success: false, error: error.message }
    }
    throw error
  }
}
