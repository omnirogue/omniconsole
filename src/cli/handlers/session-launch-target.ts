import { resolve } from 'node:path'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchHostId,
  type AgentLaunchReadinessParams,
  type AgentLaunchReadinessResult
} from '../../shared/agent-launch-account'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getOptionalStringFlag } from '../flags'
import { listSshTargets } from '../host-selector-alternatives'
import { launchHostAlsoReachableAs } from '../launch-host-name'
import { getDefaultUserDataPath, RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { resolveEnvironment } from '../runtime/environments'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import {
  PAIRING_CODE_ROUTE_ID,
  type AgentLaunchHostReceipt,
  type AgentLaunchRecord,
  type AgentLaunchRoute
} from '../session-launch-record'
import {
  hostUnreachableRefusal,
  launchEnvironmentFlagText,
  remoteCwdRefusal,
  workspaceNotFoundRefusal
} from '../session-launch-refusals'
import { heldLaunchRefusal } from './session-launch-receipt'

const STATUS_TIMEOUT_MS = 10_000
const READINESS_TIMEOUT_MS = 20_000

export type LaunchHostStatus = {
  runtimeId: string
  appVersion: string | null
  capabilities: readonly string[]
}

export type LaunchWorkspaceTarget = {
  selector: string
  /** Derived from the cwd (omitted, active or current), so a miss refuses with R14. */
  derivedFromCwd: boolean
}

/** Which runtime the routed client reaches, named the way a person would type it again. */
export function resolveLaunchRoute(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): AgentLaunchRoute {
  if (!client.isRemote) {
    return { kind: 'local' }
  }
  const host = getOptionalStringFlag(flags, 'host')
  const selector = host?.startsWith('runtime:')
    ? host.slice('runtime:'.length)
    : (getOptionalStringFlag(flags, 'environment') ?? process.env.ORCA_ENVIRONMENT)
  if (!selector) {
    return {
      kind: 'environment',
      environmentId: PAIRING_CODE_ROUTE_ID,
      name: 'the paired computer'
    }
  }
  try {
    const environment = resolveEnvironment(getDefaultUserDataPath(), selector)
    if (environment?.id) {
      return { kind: 'environment', environmentId: environment.id, name: environment.name }
    }
  } catch {
    // The router already resolved this selector; fall back to it as typed.
  }
  return { kind: 'environment', environmentId: selector, name: selector }
}

export function launchRouteName(route: AgentLaunchRoute): string {
  return route.kind === 'local' ? 'this computer' : route.name
}

export function sameLaunchRoute(a: AgentLaunchRoute, b: AgentLaunchRoute): boolean {
  return a.kind === 'local'
    ? b.kind === 'local'
    : b.kind === 'environment' && a.environmentId === b.environmentId
}

function isUnreachable(error: unknown): boolean {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}

/** status.get on the routed client: the runtime that would execute the launch. */
export async function readLaunchStatus(
  client: RuntimeClient,
  route: AgentLaunchRoute
): Promise<LaunchHostStatus> {
  try {
    const status = (
      await client.call<RuntimeStatus>('status.get', undefined, { timeoutMs: STATUS_TIMEOUT_MS })
    ).result
    return {
      runtimeId: status.runtimeId,
      appVersion: status.appVersion ?? null,
      capabilities: status.capabilities ?? []
    }
  } catch (error) {
    if (isUnreachable(error)) {
      throw hostUnreachableRefusal(launchRouteName(route), STATUS_TIMEOUT_MS / 1000, error)
    }
    throw error
  }
}

/** status.get for a recorded operation; an unreachable host keeps the record's own outcome. */
export async function readRecordedLaunchStatus(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  record: AgentLaunchRecord
): Promise<LaunchHostStatus> {
  const route = resolveLaunchRoute(flags, client)
  // Why: a name that is both a paired computer and an SSH target can resolve to the other route
  // on a re-run; the recorded request belongs to the recorded route's runtime and ledger.
  if (!sameLaunchRoute(route, record.route)) {
    throw heldLaunchRefusal('rerouted', { record, flags, route })
  }
  try {
    return await readLaunchStatus(client, record.route)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'launch_host_unverifiable') {
      throw heldLaunchRefusal('unreachable', { record, flags, cause: error })
    }
    throw error
  }
}

/**
 * `--worktree` as typed, or the workspace enclosing the cwd. The cwd belongs to this computer, so
 * a paired route refuses the shortcut (R13); a cwd outside every managed worktree falls back to
 * `path:<cwd>` so a folder-workspace root still resolves on the runtime.
 */
export async function resolveLaunchWorkspace(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  route: AgentLaunchRoute
): Promise<LaunchWorkspaceTarget> {
  const typed = getOptionalStringFlag(flags, 'worktree')
  if (typed !== undefined && typed !== 'active' && typed !== 'current') {
    const selector = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    return { selector: selector ?? typed, derivedFromCwd: false }
  }
  try {
    return { selector: await resolveCurrentWorktreeSelector(cwd, client), derivedFromCwd: true }
  } catch (error) {
    if (!(error instanceof RuntimeClientError)) {
      throw error
    }
    if (client.isRemote && error.code === 'invalid_argument') {
      throw remoteCwdRefusal(error.message, route)
    }
    if (error.code === 'selector_not_found') {
      return { selector: `path:${resolve(cwd)}`, derivedFromCwd: true }
    }
    throw error
  }
}

/** The launch's own workspace resolver on the executing runtime; read-only. */
export async function readLaunchReadiness(
  client: RuntimeClient,
  params: AgentLaunchReadinessParams,
  context: { route: AgentLaunchRoute; cwd: string; derivedFromCwd: boolean }
): Promise<AgentLaunchReadinessResult> {
  try {
    return (
      await client.call<AgentLaunchReadinessResult>(AGENT_LAUNCH_READINESS_METHOD, params, {
        timeoutMs: READINESS_TIMEOUT_MS
      })
    ).result
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_not_found') {
      if (context.derivedFromCwd) {
        throw workspaceNotFoundRefusal(resolve(context.cwd))
      }
    }
    if (isUnreachable(error)) {
      throw hostUnreachableRefusal(
        launchRouteName(context.route),
        READINESS_TIMEOUT_MS / 1000,
        error
      )
    }
    throw error
  }
}

/** The receipt's `host` block: where the session runs, why there, and where it shows up. */
export async function launchHostReceipt(args: {
  flags: Map<string, string | boolean>
  client: RuntimeClient
  route: AgentLaunchRoute
  status: LaunchHostStatus
  hostId: AgentLaunchHostId
}): Promise<AgentLaunchHostReceipt> {
  const { flags, route, hostId } = args
  const hostFlag = getOptionalStringFlag(flags, 'host')
  const sshTarget = hostId.startsWith('ssh:')
    ? (await listSshTargets(args.client)).find(
        (target) =>
          `ssh:${target.id}` === hostId || `ssh:${encodeURIComponent(target.id)}` === hostId
      )
    : undefined
  const name = sshTarget?.label ?? (hostId === 'local' ? launchRouteName(route) : hostId)
  return {
    route: route.kind === 'environment' ? 'paired' : hostId === 'local' ? 'local' : 'ssh',
    name,
    ...(route.kind === 'environment' ? { environmentId: route.environmentId } : {}),
    hostId,
    runtimeId: args.status.runtimeId,
    appVersion: args.status.appVersion,
    why: hostFlag
      ? 'named with --host'
      : route.kind === 'environment'
        ? 'named with --environment'
        : 'where the workspace lives',
    alsoReachableAs: launchHostAlsoReachableAs(hostFlag),
    visibleIn:
      route.kind === 'environment'
        ? `${route.name}'s sidebar (background); inspect terminals: omni terminal list${launchEnvironmentFlagText(route)} --json`
        : "this computer's sidebar"
  }
}
