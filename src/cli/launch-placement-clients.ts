import type { LaunchPlacementRoute } from '../shared/agent-launch-placement-types'
import type { EnvironmentSummary } from './host-selector-alternatives'
import { getDefaultUserDataPath, RuntimeClient } from './runtime-client'
import { listEnvironments } from './runtime/environments'

/** How placement reaches each computer; one client per runtime, reused for every call. */
export type LaunchPlacementClients = {
  local: () => RuntimeClient
  environment: (environmentId: string) => RuntimeClient
  environments: () => EnvironmentSummary[]
  now: () => number
}

// Why: every placement call passes its own bounded timeout; this only caps a call that does not.
const PLACEMENT_CLIENT_TIMEOUT_MS = 25_000

export function defaultLaunchPlacementClients(): LaunchPlacementClients {
  let local: RuntimeClient | undefined
  const byEnvironment = new Map<string, RuntimeClient>()
  return {
    // Why: null selectors keep an ambient ORCA_ENVIRONMENT from turning "this computer" remote.
    local: () => (local ??= new RuntimeClient(undefined, PLACEMENT_CLIENT_TIMEOUT_MS, null, null)),
    environment: (environmentId) => {
      let client = byEnvironment.get(environmentId)
      if (!client) {
        client = new RuntimeClient(undefined, PLACEMENT_CLIENT_TIMEOUT_MS, null, environmentId)
        byEnvironment.set(environmentId, client)
      }
      return client
    },
    environments: () =>
      listEnvironments(getDefaultUserDataPath()).map(({ id, name }) => ({ id, name })),
    now: () => Date.now()
  }
}

/** The client that drives a placed route: its paired runtime, else this computer's (SSH too). */
export function launchPlacementRouteClient(
  route: LaunchPlacementRoute,
  clients: LaunchPlacementClients
): RuntimeClient {
  return route.kind === 'environment' ? clients.environment(route.environmentId) : clients.local()
}
