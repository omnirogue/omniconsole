import type { TuiAgent } from '../../shared/tui-agent'
import { attestOmpRouteModels } from '../omp/omp-route-model-discovery'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { discoverLocalModelsWithAccount } from '../text-generation/local-model-listing'
import {
  discoverRemoteOmpRoutes,
  type ModelDiscoveryRefresh
} from '../text-generation/model-discovery-cache'
import {
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'
import {
  discoverHostFolderCommitMessageModels,
  FOLDER_WORKSPACE_SELECTOR
} from './runtime-folder-model-discovery'
import { localGitOptionsForTarget, type RuntimeGitCommandHost } from './runtime-git-command-target'
import {
  localAgentRuntimeTargetForTarget,
  type RuntimeCommitMessageSettingsOverride
} from './runtime-git-generation-context'

export async function discoverRuntimeWorkspaceModels(
  host: RuntimeGitCommandHost,
  worktreeSelector: string,
  agentId: string,
  settingsOverride?: Pick<RuntimeCommitMessageSettingsOverride, 'agentCmdOverrides'>,
  /** A launch's explicit refresh: a failed listing on record runs again at once. */
  refresh?: ModelDiscoveryRefresh
): Promise<DiscoverCommitMessageModelsResult> {
  const typedAgentId = agentId as TuiAgent
  const agentCommandOverride =
    settingsOverride?.agentCmdOverrides?.[typedAgentId] ??
    host.getRuntimeSettings().agentCmdOverrides?.[typedAgentId]
  const forced = refresh?.force ? ({ force: true } as const) : undefined
  if (FOLDER_WORKSPACE_SELECTOR.test(worktreeSelector)) {
    const resolvers = host.getCommitMessageAgentEnvironment?.()
    return forced
      ? discoverHostFolderCommitMessageModels(typedAgentId, resolvers, agentCommandOverride, forced)
      : discoverHostFolderCommitMessageModels(typedAgentId, resolvers, agentCommandOverride)
  }
  const target = await host.resolveRuntimeGitTarget(worktreeSelector)
  if (target.connectionId) {
    const provider = getSshGitProvider(target.connectionId)
    if (!provider) {
      return { success: false, error: `No git provider for connection "${target.connectionId}"` }
    }
    if (typedAgentId === 'omp' && !agentCommandOverride) {
      return discoverRemoteOmpRoutes(
        target.connectionId,
        () => provider.discoverOmpRoutes(),
        refresh
      )
    }
    // Why its own lane: a commit message on this worktree never queues behind a listing.
    const execute: Parameters<typeof discoverCommitMessageModelsRemote>[2] = (
      plan,
      cwd,
      timeoutMs
    ) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs, 'model-discovery')
    const { path } = target.worktree
    return forced
      ? discoverCommitMessageModelsRemote(
          typedAgentId,
          path,
          execute,
          agentCommandOverride,
          target.connectionId,
          forced
        )
      : discoverCommitMessageModelsRemote(
          typedAgentId,
          path,
          execute,
          agentCommandOverride,
          target.connectionId
        )
  }
  const localOptions = localGitOptionsForTarget(target)
  const wsl = localOptions.wslDistro
    ? { cwd: target.worktree.path, wslDistro: localOptions.wslDistro }
    : null
  // Why through the account lookup: an opening answered from the host's listing sets up no
  // Claude or Codex account.
  return discoverLocalModelsWithAccount(
    {
      agentId: typedAgentId,
      agentCommandOverride,
      resolvers: host.getCommitMessageAgentEnvironment?.(),
      target: localAgentRuntimeTargetForTarget(target),
      refresh: forced
    },
    async (env) => {
      const result = await (wsl || forced
        ? discoverCommitMessageModelsLocal(typedAgentId, env, agentCommandOverride, {
            ...wsl,
            ...forced
          })
        : discoverCommitMessageModelsLocal(typedAgentId, env, agentCommandOverride))
      if (typedAgentId !== 'omp' || localOptions.wslDistro || agentCommandOverride) {
        return result
      }
      return forced ? attestOmpRouteModels(result, env, forced) : attestOmpRouteModels(result, env)
    }
  )
}
