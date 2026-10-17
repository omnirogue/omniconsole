import type { LaunchPlacementRoute } from '../shared/agent-launch-placement-types'
import { parseExecutionHostId } from '../shared/execution-host'
import {
  findEnvironmentByName,
  findSshTargetByName,
  type EnvironmentSummary,
  type SshTargetSummary
} from './host-selector-alternatives'
import { launchHostValue } from './launch-capacity-commands'
import { isLocalLaunchHostAlias, unresolvedLaunchHostRefusal } from './launch-host-name'
import { quoteCliCommandArgument } from './shell-command-quote'

/** --host next to --project: the routes of that one computer, by any name omni host list prints. */
export type LaunchPlacementHostFilter = {
  typed: string
  local: boolean
  environmentIds: Set<string>
  sshTargetIds: Set<string>
}

export function resolveLaunchPlacementHostFilter(
  typed: string | undefined,
  environments: EnvironmentSummary[],
  sshTargets: SshTargetSummary[]
): LaunchPlacementHostFilter | null {
  const name = typed?.trim()
  if (!name || name.toLowerCase() === 'auto') {
    return null
  }
  const filter: LaunchPlacementHostFilter = {
    typed: name,
    local: false,
    environmentIds: new Set(),
    sshTargetIds: new Set()
  }
  if (isLocalLaunchHostAlias(name)) {
    return { ...filter, local: true }
  }
  const explicit = parseExecutionHostId(name)
  const environment =
    explicit?.kind === 'ssh'
      ? undefined
      : findEnvironmentByName(
          environments,
          explicit?.kind === 'runtime' ? explicit.environmentId : name
        )
  const ssh =
    explicit?.kind === 'runtime'
      ? undefined
      : findSshTargetByName(sshTargets, explicit?.kind === 'ssh' ? explicit.targetId : name)
  if (!environment && !ssh) {
    throw unresolvedLaunchHostRefusal(name, environments, sshTargets)
  }
  return {
    ...filter,
    environmentIds: new Set(environment ? [environment.id] : []),
    sshTargetIds: new Set(ssh ? [ssh.id] : [])
  }
}

export function launchPlacementRouteAllowed(
  filter: LaunchPlacementHostFilter | null,
  route: LaunchPlacementRoute
): boolean {
  if (!filter) {
    return true
  }
  return route.kind === 'local'
    ? filter.local
    : route.kind === 'environment'
      ? filter.environmentIds.has(route.environmentId)
      : filter.sshTargetIds.has(route.targetId)
}

/** The --host that pins a placement to one route's computer, by name when the name is unique. */
export function launchPlacementHostFlag(
  route: LaunchPlacementRoute,
  environments: EnvironmentSummary[],
  sshTargets: SshTargetSummary[]
): string {
  if (route.kind === 'local') {
    return 'local'
  }
  const [name, exact, unique] =
    route.kind === 'environment'
      ? [
          route.name,
          `runtime:${route.environmentId}`,
          findEnvironmentByName(environments, route.name)?.id === route.environmentId &&
            !findSshTargetByName(sshTargets, route.name)
        ]
      : [
          route.label,
          `ssh:${route.targetId}`,
          findSshTargetByName(sshTargets, route.label)?.id === route.targetId &&
            !findEnvironmentByName(environments, route.label)
        ]
  // Why the exact selector for a shared name: placement has no workspace to settle a name that a
  // paired computer and an SSH target share (`omni host list` prints it; the workspace picks).
  return launchHostValue(name, unique, exact)
}

export function launchPlacementHostFlagText(host: string): string {
  return `--host ${quoteCliCommandArgument(host)}`
}
