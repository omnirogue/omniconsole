/**
 * `omni session launch --host <computer>` takes the names `omni host list` prints. Rewriting
 * them to `runtime:<id>` or `ssh:<id>` before routing lets the global router route and
 * conflict-check a paired name exactly as it does an explicit `--host runtime:<id>`.
 */

import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessResult
} from '../shared/agent-launch-account'
import { parseExecutionHostId, toSshExecutionHostId } from '../shared/execution-host'
import { getOptionalStringFlag } from './flags'
import {
  ambiguousEnvironments,
  ambiguousSshTargets,
  findEnvironmentByName,
  findSshTargetByName,
  listSshTargets,
  type EnvironmentSummary,
  type SshTargetSummary
} from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { autoHostRefusal } from './session-launch-refusals'

// Session prep's aliases for this computer (session-prep-execution-host.ts), plus the name
// `omni host list` prints for it.
const LOCAL_HOST_ALIASES = new Set(['local', 'this computer', 'this mac', 'this machine'])

export function isLocalLaunchHostAlias(name: string): boolean {
  return LOCAL_HOST_ALIASES.has(name.trim().toLowerCase())
}

/** --project picks the computer itself, so --host there is a filter it resolves, not a route. */
export function launchHostFlagPlacesItself(flags: Map<string, string | boolean>): boolean {
  return typeof flags.get('project') === 'string'
}

export type LaunchHostNameDeps = {
  listEnvironments: () => Promise<EnvironmentSummary[]>
  /** SSH targets registered on this computer's runtime. */
  listSshTargets: () => Promise<SshTargetSummary[]>
  /** The host id this computer's runtime resolves `worktree` to, or null when it cannot say. */
  localWorkspaceHostId: (worktree: string) => Promise<string | null>
  /** --environment, ORCA_ENVIRONMENT or a pairing code already selects a server. */
  serverSelected: boolean
}

// Why: index.ts canonicalizes before dispatch; the handler's receipt names the route not taken.
let lastAlternative: { host: string; alsoReachableAs: string[] } | null = null

export function launchHostAlsoReachableAs(host: string | undefined): string[] {
  return lastAlternative !== null && lastAlternative.host === host
    ? lastAlternative.alsoReachableAs
    : []
}

const typedHosts = new WeakMap<Map<string, string | boolean>, string>()
const typedCommands = new WeakMap<Map<string, string | boolean>, Map<string, string | boolean>>()

/**
 * The flags with --host as typed. The rewrite can depend on how this computer's runtime answers
 * at that moment, so the intent key and the retry command use the typed value: re-running the
 * identical command must find the same launch record whichever route it resolves to.
 */
export function launchFlagsAsTyped(
  flags: Map<string, string | boolean>
): Map<string, string | boolean> {
  const command = typedCommands.get(flags)
  if (command) {
    return command
  }
  const typed = typedHosts.get(flags)
  return typed === undefined || flags.get('host') === typed
    ? flags
    : new Map([...flags, ['host', typed]])
}

/**
 * Flags that route one launch step to a placed computer (`undefined` deletes a flag). The retry
 * command and intent still read the command as typed, so re-running it follows the placement.
 */
export function routedLaunchFlags(
  typed: Map<string, string | boolean>,
  overrides: Record<string, string | undefined>
): Map<string, string | boolean> {
  const routed = new Map(typed)
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      routed.delete(name)
    } else {
      routed.set(name, value)
    }
  }
  typedCommands.set(routed, launchFlagsAsTyped(typed))
  return routed
}

export async function canonicalizeLaunchHostFlag(
  flags: Map<string, string | boolean>,
  deps: LaunchHostNameDeps
): Promise<void> {
  lastAlternative = null
  const raw = flags.get('host')
  if (typeof raw !== 'string') {
    return
  }
  typedHosts.set(flags, raw)
  const name = raw.trim()
  // Why: like `workflow run` (hostFlagNamesFleetHost), placement resolves --host against the
  // fleet it reads; rewriting it here would drop the other route to a same-named computer.
  if (launchHostFlagPlacesItself(flags)) {
    return
  }
  if (name.toLowerCase() === 'auto') {
    throw autoHostRefusal()
  }
  // Why: with a server already selected only the explicit forms keep today's meaning there.
  if (parseExecutionHostId(name) || deps.serverSelected) {
    return
  }
  if (isLocalLaunchHostAlias(name)) {
    flags.set('host', 'local')
    return
  }
  const [environments, sshTargets] = await Promise.all([
    deps.listEnvironments(),
    deps.listSshTargets()
  ])
  const environment = findEnvironmentByName(environments, name)
  const ssh = findSshTargetByName(sshTargets, name)
  if (environment && ssh) {
    const paired = `runtime:${environment.id}`
    const viaSsh = toSshExecutionHostId(ssh.id)
    // Why: both routes reach that machine, but only the SSH route executes a workspace this
    // computer registered on it; anything else (unknown here, or an old runtime) goes paired.
    const worktree = getOptionalStringFlag(flags, 'worktree')
    const workspaceHost =
      worktree === undefined || worktree === 'active' || worktree === 'current'
        ? null
        : parseExecutionHostId(await deps.localWorkspaceHostId(worktree))
    const followsSsh = workspaceHost?.kind === 'ssh' && workspaceHost.targetId === ssh.id
    flags.set('host', followsSsh ? viaSsh : paired)
    lastAlternative = {
      host: followsSsh ? viaSsh : paired,
      alsoReachableAs: [followsSsh ? paired : viaSsh]
    }
    return
  }
  if (environment) {
    flags.set('host', `runtime:${environment.id}`)
    return
  }
  if (ssh) {
    flags.set('host', toSshExecutionHostId(ssh.id))
    return
  }
  throw unresolvedLaunchHostRefusal(name, environments, sshTargets)
}

export function unresolvedLaunchHostRefusal(
  name: string,
  environments: EnvironmentSummary[],
  sshTargets: SshTargetSummary[]
): RuntimeClientError {
  const sameNamedServers = ambiguousEnvironments(environments, name)
  const sameNamedTargets = ambiguousSshTargets(sshTargets, name)
  if (sameNamedServers.length > 0 || sameNamedTargets.length > 0) {
    return new RuntimeClientError(
      'invalid_argument',
      `Ambiguous computer in --host ${name}: ${sameNamedServers.length + sameNamedTargets.length} computers share that name. Use its id.`,
      {
        knownEnvironments: sameNamedServers,
        knownSshTargets: sameNamedTargets,
        nextSteps: [
          ...sameNamedServers.map(
            (server) => `Use --host runtime:${server.id} for ${server.name}.`
          ),
          ...sameNamedTargets.map((target) => `Use --host ssh:${target.id} for ${target.label}.`)
        ]
      }
    )
  }
  return new RuntimeClientError(
    'invalid_argument',
    `Unknown computer in --host ${name}: no paired OmniConsole server or SSH target on this computer is named or has id ${name}.`,
    {
      knownEnvironments: environments,
      knownSshTargets: sshTargets,
      nextSteps: [
        'Run `omni host list` to see every computer you can name.',
        'Use --host local for this computer.'
      ]
    }
  )
}

/** This computer's runtime resolves the workspace read-only; any failure means "cannot say". */
export async function readLaunchWorkspaceHostId(
  client: RuntimeClient,
  worktree: string,
  provider: string | undefined
): Promise<string | null> {
  if (provider !== 'claude' && provider !== 'codex') {
    return null
  }
  try {
    const response = await client.call<AgentLaunchReadinessResult>(
      AGENT_LAUNCH_READINESS_METHOD,
      { worktree, agent: provider, preview: false },
      { timeoutMs: 10_000 }
    )
    return response.result.workspace.hostId
  } catch {
    return null
  }
}

/** The wiring index.ts uses: this computer's pairing store and its own runtime. */
export function cliLaunchHostNameDeps(
  flags: Map<string, string | boolean>,
  localClient: () => RuntimeClient,
  env: NodeJS.ProcessEnv = process.env
): LaunchHostNameDeps {
  return {
    listEnvironments: async () => {
      const [{ listEnvironments }, { getDefaultUserDataPath }] = await Promise.all([
        import('./runtime/environments.js'),
        import('./runtime-client.js')
      ])
      return listEnvironments(getDefaultUserDataPath()).map(({ id, name }) => ({ id, name }))
    },
    listSshTargets: () => listSshTargets(localClient()),
    localWorkspaceHostId: (worktree) =>
      readLaunchWorkspaceHostId(localClient(), worktree, getOptionalStringFlag(flags, 'provider')),
    serverSelected:
      flags.has('environment') ||
      flags.has('pairing-code') ||
      Boolean(env.ORCA_ENVIRONMENT || env.ORCA_PAIRING_CODE || env.ORCA_REMOTE_PAIRING)
  }
}
