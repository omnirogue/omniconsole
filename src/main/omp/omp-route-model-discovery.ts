import type { DiscoverCommitMessageModelsResult } from '../text-generation/source-control-text-generation-types'
import {
  activeModelDiscoveryCache,
  type ModelDiscoveryRefresh
} from '../text-generation/model-discovery-cache'
import { assertOmpRouteVersion } from './omp-route-version'
import { openrouterApiId } from '../../shared/openrouter-route'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

/** OpenRouter ids that take tools, or null when this host's OMP cannot attest any route. */
async function readOmpRouteEligibility(
  environment: NodeJS.ProcessEnv | undefined
): Promise<ReadonlySet<string> | null> {
  let response: Response | undefined
  try {
    await assertOmpRouteVersion(environment)
    response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as {
      data?: { id?: string; supported_parameters?: string[] }[]
    }
    if (!Array.isArray(payload.data)) {
      return null
    }
    return new Set(
      payload.data
        .filter((model) => model.supported_parameters?.includes('tools'))
        .flatMap((model) => (model.id ? [model.id] : []))
    )
  } catch {
    return null
  } finally {
    if (response) {
      await cancelUnreadResponseBody(response)
    }
  }
}

/**
 * Why cached on the host: the check starts `omp --version` (a bun process) and fetches the
 * OpenRouter catalog, which every listing repeated even when the listing itself was cached. It
 * is kept per OMP binary for the listing lifetime (a failed check for the failure window), so an
 * OMP update checks again at once. The relay installs no cache and checks every time.
 */
async function ompRouteEligibility(
  environment: NodeJS.ProcessEnv | undefined,
  refresh: ModelDiscoveryRefresh | undefined
): Promise<ReadonlySet<string> | null> {
  const cache = activeModelDiscoveryCache()
  const binary = cache && environment ? await cache.fingerprint('omp', environment) : null
  return cache && binary
    ? cache.remember(
        ['omp-route-eligibility', binary],
        () => readOmpRouteEligibility(environment),
        (eligible) => eligible !== null,
        refresh
      )
    : readOmpRouteEligibility(environment)
}

/**
 * Eligibility is attested by the execution host, never inferred from a seeded catalog. `refresh`:
 * a launch checks again at once when the last check failed.
 */
export async function attestOmpRouteModels(
  result: DiscoverCommitMessageModelsResult,
  environment?: NodeJS.ProcessEnv,
  refresh?: ModelDiscoveryRefresh
): Promise<DiscoverCommitMessageModelsResult> {
  if (!result.success || result.catalogOrigin !== 'probe') {
    return result
  }
  const eligible = await ompRouteEligibility(environment, refresh)
  if (!eligible) {
    return result
  }
  return {
    ...result,
    models: result.models.map((model) =>
      model.id.startsWith('openrouter/') &&
      openrouterApiId.safeParse(model.id.slice(11)).success &&
      eligible.has(model.id.slice(11))
        ? { ...model, openrouterRouting: 'omp-openrouter-routing-v1' as const }
        : model
    )
  }
}
