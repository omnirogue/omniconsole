import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { discoverLocalModelsWithAccount } from '../text-generation/local-model-listing'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'
import type { TuiAgent } from '../../shared/tui-agent'
import { attestOmpRouteModels } from '../omp/omp-route-model-discovery'
import type { ModelDiscoveryRefresh } from '../text-generation/model-discovery-cache'

/** A folder workspace selector names no git target; `id:` is optional like every runtime selector. */
export const FOLDER_WORKSPACE_SELECTOR = /^(?:id:)?folder:/

/** Why: a folder workspace has no git target; its agents are this host's own installs. */
export async function discoverHostFolderCommitMessageModels(
  agent: TuiAgent,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  agentCommandOverride: string | undefined,
  refresh?: ModelDiscoveryRefresh
): Promise<DiscoverCommitMessageModelsResult> {
  const forced = refresh?.force ? ({ force: true } as const) : undefined
  // Why through the account lookup: an opening answered from the host's listing sets up no
  // Claude or Codex account.
  return discoverLocalModelsWithAccount(
    {
      agentId: agent,
      agentCommandOverride,
      resolvers,
      target: { runtime: 'host' },
      refresh: forced
    },
    async (env) => {
      const result = await (forced
        ? discoverCommitMessageModelsLocal(agent, env, agentCommandOverride, forced)
        : discoverCommitMessageModelsLocal(agent, env, agentCommandOverride))
      if (agent !== 'omp' || agentCommandOverride) {
        return result
      }
      return forced ? attestOmpRouteModels(result, env, forced) : attestOmpRouteModels(result, env)
    }
  )
}
