import { assertOmpRelayArgs } from '../../shared/omp-route-relay'
import { assertOmpRouteVersion } from './omp-route-version'
import { ompRouteLaunchArgs } from './omp-route-config'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { assertOpenRouterRoute } from '../../shared/openrouter-route'
import { getOmpApprovalOverlayConfigPath } from '../../shared/omp-approval-overlay'
import { quoteStartupArg, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'

export async function resolveOmpRouteLaunchArgs(
  input: Parameters<typeof ompRouteLaunchArgs>[0] & {
    connectionId?: string | null
    isWsl?: boolean
    commandOverride?: string
    agentEnv?: Record<string, string>
  }
): Promise<string | null | undefined> {
  assertOpenRouterRoute({ agent: input.agent, ...input.preferences })
  if (input.agent === 'omp' && input.preferences?.model && input.commandOverride) {
    throw new Error(
      'Exact OMP routes require the host default launcher. Remove the OMP command override in Agent settings.'
    )
  }
  if (input.agent === 'omp' && input.preferences?.model && input.isWsl) {
    throw new Error('omp_route_capability_unavailable: WSL exact OMP routes are not supported.')
  }
  if (!input.isRemote && input.agent === 'omp' && input.preferences?.model) {
    await assertOmpRouteVersion()
  }
  if (!input.isRemote || input.agent !== 'omp' || !input.preferences?.model) {
    return ompRouteLaunchArgs(input)
  }
  if (
    !input.connectionId ||
    input.commandOverride ||
    (input.shell && input.shell !== 'posix') ||
    Object.keys(input.agentEnv ?? {}).length > 0
  ) {
    throw new Error(
      'omp_route_capability_unavailable: SSH OMP routes require the host default launcher and environment.'
    )
  }
  const parsed = tokenizeStartupCommand(input.agentArgs ?? '', input.shell ?? 'posix')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const tokens = [...parsed.tokens]
  let approval = false
  const config = tokens.indexOf('--config')
  if (config !== -1 && tokens[config + 1] === getOmpApprovalOverlayConfigPath()) {
    approval = true
    tokens.splice(config, 2)
  }
  if (tokens.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
    throw new Error('An explicit OMP config cannot override the saved model route.')
  }
  assertOmpRelayArgs(tokens)
  const provider = requireSshGitProvider(input.connectionId)
  const args = await provider.prepareOmpRoute({
    model: input.preferences.model,
    ...(input.preferences.openrouterCandidates !== undefined
      ? { openrouterCandidates: input.preferences.openrouterCandidates }
      : {}),
    agentArgs: tokens.map((arg) => quoteStartupArg(arg, 'posix')).join(' '),
    approval
  })
  if (requireSshGitProvider(input.connectionId) !== provider) {
    throw new Error('SSH connection changed while preparing the OMP route. Retry launch.')
  }
  return args
}
