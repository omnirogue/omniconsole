import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { TuiAgent } from '../../shared/tui-agent'
import { WorkflowScriptSlots } from '../runtime/workflow-script/workflow-script-slots'
import { discoverRemoteOmpRoutes } from '../text-generation/model-discovery-cache'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  discoverCommitMessageModelsRemote,
  type DiscoverCommitMessageModelsResult
} from '../text-generation/commit-message-text-generation'
import type {
  SessionPrepRouterCatalog,
  SessionPrepRouterRequest
} from './session-prep-router-types'

export type SessionPrepModelDiscovery = (
  selector: string,
  agent: string
) => Promise<DiscoverCommitMessageModelsResult>
type Listing = SessionPrepRouterCatalog['agents'][number]
const WAIT_MS = 3_000

/** Shares the execution owner's model listings; static menu entries never attest availability. */
export function createSessionPrepModelCatalog(discover: SessionPrepModelDiscovery) {
  // Completed listings remain in the existing account-aware discovery cache.
  const pending = new Map<string, Promise<Listing>>()
  const slots = new WorkflowScriptSlots(2)
  return async (request: SessionPrepRouterRequest): Promise<SessionPrepRouterCatalog> => {
    const target = request.executionTarget
    const hostId = target?.hostId ?? (target?.connectionId ? `ssh:${target.connectionId}` : 'local')
    const agents = [
      ...new Set(request.provider ? [request.provider] : (request.enabledProviders ?? []))
    ]
    const started = Date.now()
    const unavailable = (provider: TuiAgent, error: string): Listing => ({
      provider,
      models: [],
      discovered: false,
      error
    })
    if (!target?.repoId || !target.path || hostId.startsWith('runtime:')) {
      return {
        hostId,
        observedAt: started,
        agents: agents.map((agent) =>
          unavailable(agent, 'Execution workspace cannot be verified for model discovery.')
        )
      }
    }
    const selector = `id:${target.isFolder ? target.repoId : getRepoMainWorktreeId({ id: target.repoId, path: target.path })}`
    const entries = agents.map((provider) => {
      const key = JSON.stringify([hostId, target.connectionId, selector, provider])
      let result = pending.get(key)
      if (!result) {
        result = slots
          .run(async () => {
            let listing: DiscoverCommitMessageModelsResult
            if (target.isFolder && target.connectionId) {
              const remote = requireSshGitProvider(target.connectionId)
              listing =
                provider === 'omp'
                  ? await discoverRemoteOmpRoutes(target.connectionId, () =>
                      remote.discoverOmpRoutes()
                    )
                  : await discoverCommitMessageModelsRemote(
                      provider,
                      target.path,
                      (plan, cwd, timeoutMs) =>
                        remote.executeCommitMessagePlan(plan, cwd, timeoutMs, 'model-discovery'),
                      undefined,
                      target.connectionId
                    )
            } else {
              listing = await discover(selector, provider)
            }
            return listing.success
              ? {
                  provider,
                  models: listing.models,
                  discovered: listing.catalogOrigin === 'probe',
                  ...(listing.catalogOrigin !== 'probe'
                    ? { error: 'Only a static model menu is available.' }
                    : {})
                }
              : unavailable(provider, listing.error)
          })
          .catch((error: unknown) =>
            unavailable(
              provider,
              error instanceof Error ? error.message : 'Model discovery failed.'
            )
          )
          .finally(() => {
            pending.delete(key)
          })
        pending.set(key, result)
      }
      return withTimeout(
        result,
        WAIT_MS,
        unavailable(provider, 'Execution host model discovery is still pending.')
      )
    })
    return { hostId, observedAt: started, agents: await Promise.all(entries) }
  }
}
