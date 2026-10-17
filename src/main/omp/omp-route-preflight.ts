import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { assertOpenRouterRoute, openrouterApiId } from '../../shared/openrouter-route'

/** Auth availability is host-owned; public metadata only attests tool support. */
export async function assertLocalOmpRoute(
  runtime: Pick<OrcaRuntimeService, 'discoverRuntimeCommitMessageModels'>,
  worktree: string,
  route: AgentLaunchPreferences
): Promise<void> {
  assertOpenRouterRoute({ agent: 'omp', ...route })
  if (
    !route.model?.startsWith('openrouter/') ||
    !openrouterApiId.safeParse(route.model.slice(11)).success
  ) {
    throw new Error('OMP continuation requires an exact OpenRouter model.')
  }
  const selected = route.openrouterCandidates ?? [route.model.slice(11)]
  const catalog = await runtime.discoverRuntimeCommitMessageModels(worktree, 'omp')
  if (
    !catalog.success ||
    catalog.catalogOrigin !== 'probe' ||
    selected.some(
      (id) =>
        !catalog.models.some(
          (model) =>
            model.id === `openrouter/${id}` &&
            model.openrouterRouting === 'omp-openrouter-routing-v1'
        )
    )
  ) {
    throw new Error('The execution host could not verify every selected OMP model.')
  }
}
