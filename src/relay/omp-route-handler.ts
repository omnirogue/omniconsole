import { buildRelayCommandEnv } from './relay-command-env'
import type { RelayDispatcher } from './dispatcher'
import { runProcess } from '../shared/child-process/run-process'
import { getAgentModelProbeSpec } from '../shared/agent-model-probe-spec'
import { OMP_MODEL_LIST_ARGS } from '../shared/omp-model-list-probe'
import {
  OMP_ROUTE_RELAY_CAPABILITY,
  OMP_ROUTE_RELAY_DISCOVER,
  OMP_ROUTE_RELAY_PREPARE,
  OMP_ROUTE_RELAY_UNAVAILABLE,
  ompRelayRouteRequest,
  assertOmpRelayArgs
} from '../shared/omp-route-relay'
import { finalizeModelDiscoveryOutput } from '../main/text-generation/commit-message-model-discovery-policy'
import { attestOmpRouteModels } from '../main/omp/omp-route-model-discovery'
import { assertOmpRouteVersion } from '../main/omp/omp-route-version'
import { ompRouteLaunchArgs } from '../main/omp/omp-route-config'
import { tokenizeStartupCommand } from '../shared/tui-agent-startup-shell'

export async function discoverRelayOmpRoutes() {
  try {
    if (process.platform === 'win32') {
      throw new Error(OMP_ROUTE_RELAY_UNAVAILABLE)
    }
    const environment = buildRelayCommandEnv(process.env)
    await assertOmpRouteVersion(environment)
    const output = await runProcess({
      program: 'omp',
      args: OMP_MODEL_LIST_ARGS,
      env: environment,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024
    })
    const result = finalizeModelDiscoveryOutput(
      getAgentModelProbeSpec('omp')!,
      output.stdout,
      output.stderr,
      output.code
    )
    return await attestOmpRouteModels(result, environment)
  } catch {
    return { success: false as const, error: OMP_ROUTE_RELAY_UNAVAILABLE }
  }
}

export function registerOmpRouteHandlers(dispatcher: RelayDispatcher): void {
  dispatcher.onRequest(OMP_ROUTE_RELAY_DISCOVER, async () => ({
    capability: OMP_ROUTE_RELAY_CAPABILITY,
    catalog: await discoverRelayOmpRoutes()
  }))
  dispatcher.onRequest(OMP_ROUTE_RELAY_PREPARE, async (params) => {
    const request = ompRelayRouteRequest.parse(params)
    const parsed = tokenizeStartupCommand(request.agentArgs, 'posix')
    if (
      !parsed.ok ||
      parsed.tokens.some((arg) => arg === '--config' || arg.startsWith('--config='))
    ) {
      throw new Error('An explicit OMP config cannot override the saved model route.')
    }
    assertOmpRelayArgs(parsed.tokens)
    const catalog = await discoverRelayOmpRoutes()
    const selected = request.openrouterCandidates ?? [request.model.slice(11)]
    if (
      !catalog.success ||
      catalog.catalogOrigin !== 'probe' ||
      selected.some(
        (id) =>
          !catalog.models.some(
            (row) =>
              row.id === `openrouter/${id}` && row.openrouterRouting === OMP_ROUTE_RELAY_CAPABILITY
          )
      )
    ) {
      throw new Error(
        `${OMP_ROUTE_RELAY_UNAVAILABLE} Every selected model must be authenticated and tool-capable on the execution host.`
      )
    }
    return {
      capability: OMP_ROUTE_RELAY_CAPABILITY,
      agentArgs: ompRouteLaunchArgs({
        agent: 'omp',
        preferences: request,
        agentArgs: request.agentArgs,
        approval: request.approval,
        shell: 'posix'
      })
    }
  })
}
