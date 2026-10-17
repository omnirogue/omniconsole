/**
 * The read-only RPCs the launch candidate reader (launch-candidate-reader.ts) sends to one
 * computer, each bounded by its own timeout. A failure names its code, never the transport's
 * message, and reads as unverifiable.
 */

import { chooseVerifiedLaunchAccount } from '../shared/account-launch-verdict'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessParams,
  type AgentLaunchReadinessResult
} from '../shared/agent-launch-account'
import {
  LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS,
  LAUNCH_PLACEMENT_SETUP_TIMEOUT_MS,
  LAUNCH_PLACEMENT_STATUS_TIMEOUT_MS,
  launchCapacityFromChoice,
  type LaunchCapacityAccounts,
  type LaunchPlacementProject
} from '../shared/agent-launch-placement-types'
import type { Project, ProjectHostSetup } from '../shared/project-types'
import type {
  CapacityProvider,
  ProviderAccountCapacitySnapshot
} from '../shared/provider-account-capacity'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../shared/remote-runtime-client-error-classification'
import type { RuntimeStatus } from '../shared/runtime-types'
import type {
  LaunchReadinessRead,
  LaunchSetupsRead,
  LaunchStatusRead
} from './launch-candidate-state'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

export type LaunchRpcClient = Pick<RuntimeClient, 'call'>

/** Which account a preview or a listing classifies for. */
export type LaunchAccountAsk = { provider: CapacityProvider; model: string | null }

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Never the raw message: a transport error can carry the pairing endpoint. */
export function candidateReadFailure(
  error: unknown,
  timeoutMs: number
): { reason: string; unreachable: boolean } {
  const code = errorCode(error)
  if (!isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))) {
    return { reason: `could not be read (${code ?? 'error'}; unverifiable)`, unreachable: false }
  }
  return {
    reason:
      code === 'runtime_timeout' || code === 'timeout'
        ? `did not answer within ${timeoutMs / 1000} s (unverifiable)`
        : `could not be reached (${code ?? 'connection failed'}; unverifiable)`,
    unreachable: true
  }
}

async function callWithin<T>(
  client: LaunchRpcClient,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<T> {
  return (await client.call<T>(method, params, { timeoutMs })).result
}

export async function readCandidateStatus(client: LaunchRpcClient): Promise<LaunchStatusRead> {
  try {
    const status = await callWithin<RuntimeStatus>(
      client,
      'status.get',
      undefined,
      LAUNCH_PLACEMENT_STATUS_TIMEOUT_MS
    )
    return {
      ok: true,
      runtimeId: status.runtimeId,
      appVersion: status.appVersion ?? null,
      capabilities: status.capabilities ?? [],
      sessionHostId: status.sessionHost?.hostId ?? null,
      hostPlatform: status.hostPlatform ?? null
    }
  } catch (error) {
    return {
      ok: false,
      reason: candidateReadFailure(error, LAUNCH_PLACEMENT_STATUS_TIMEOUT_MS).reason
    }
  }
}

export async function readCandidateSetups(client: LaunchRpcClient): Promise<LaunchSetupsRead> {
  try {
    const { setups } = await callWithin<{ setups: ProjectHostSetup[] }>(
      client,
      'projectHostSetup.list',
      undefined,
      LAUNCH_PLACEMENT_SETUP_TIMEOUT_MS
    )
    return { ok: true, setups }
  } catch (error) {
    if (errorCode(error) === 'method_not_found') {
      return { ok: false, unsupported: true, reason: 'this OmniConsole cannot list project setups' }
    }
    const { reason } = candidateReadFailure(error, LAUNCH_PLACEMENT_SETUP_TIMEOUT_MS)
    return { ok: false, unsupported: false, reason: `project setups ${reason}` }
  }
}

export async function readCandidateReadiness(
  client: LaunchRpcClient,
  worktree: string,
  query: LaunchAccountAsk
): Promise<LaunchReadinessRead> {
  const params: AgentLaunchReadinessParams = {
    worktree,
    agent: query.provider,
    ...(query.model ? { model: query.model } : {}),
    preview: true
  }
  const ask = (sent: AgentLaunchReadinessParams) =>
    callWithin<AgentLaunchReadinessResult>(
      client,
      AGENT_LAUNCH_READINESS_METHOD,
      sent,
      LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS
    )
  try {
    return { ok: true, result: await ask({ ...params, load: true }) }
  } catch (error) {
    // Why: the first verified-launch runtimes parse readiness strictly and refuse `load`.
    if (errorCode(error) === 'invalid_argument') {
      try {
        return { ok: true, result: await ask(params) }
      } catch (retryError) {
        return {
          ok: false,
          ...candidateReadFailure(retryError, LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS)
        }
      }
    }
    return { ok: false, ...candidateReadFailure(error, LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS) }
  }
}

/** An older runtime's own capacity rows, classified here exactly as its picker would. */
export async function readCandidateListedAccounts(
  client: LaunchRpcClient,
  query: LaunchAccountAsk,
  now: () => number
): Promise<LaunchCapacityAccounts> {
  const sentAt = now()
  const unread = (freshness: 'unknown' | 'unverifiable'): LaunchCapacityAccounts => ({
    freshness,
    bestRemainingPercent: null,
    boundBy: null,
    readingAgeMs: null,
    verifiedCount: 0,
    consideredCount: 0,
    source: 'accounts-list'
  })
  try {
    const snapshot = await callWithin<{
      rateLimits?: { accountCapacity?: ProviderAccountCapacitySnapshot }
    }>(client, 'accounts.list', { refreshUsage: true }, LAUNCH_PLACEMENT_READINESS_TIMEOUT_MS)
    const capacity = snapshot.rateLimits?.accountCapacity
    if (!capacity) {
      return unread('unknown')
    }
    // Why: ages on the reading host's own clock plus the round trip, so clock skew between
    // computers can never make a reading look fresher than it is.
    const hostNow = capacity.builtAt + Math.max(0, now() - sentAt)
    const choice = chooseVerifiedLaunchAccount(capacity[query.provider] ?? [], {
      provider: query.provider,
      model: query.model,
      now: hostNow
    })
    return launchCapacityFromChoice(choice, hostNow)
  } catch {
    return unread('unverifiable')
  }
}

/**
 * `--project <name|id>` as this computer knows it: an exact id, else a unique display name. An
 * identity key this computer does not list (`github:`, `git:`, `repo:`) is used as typed.
 */
export async function resolveLaunchProject(
  input: string,
  client: LaunchRpcClient
): Promise<LaunchPlacementProject> {
  const typed = input.trim()
  const wanted = typed.toLowerCase()
  const projects = await callWithin<{ projects: Project[] }>(
    client,
    'project.list',
    undefined,
    LAUNCH_PLACEMENT_SETUP_TIMEOUT_MS
  )
    .then((result) => result.projects)
    .catch((): Project[] => [])
  const byName = projects.filter((project) => project.displayName.trim().toLowerCase() === wanted)
  const match =
    projects.find((project) => project.id.toLowerCase() === wanted) ??
    (byName.length === 1 ? byName[0] : undefined)
  if (match) {
    return { input, identityKey: match.id, name: match.displayName }
  }
  if (byName.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Ambiguous project "${typed}": ${byName.length} projects share that name. Pass its id: ${byName.map((project) => project.id).join(', ')}.`
    )
  }
  if (/^(github|git|repo):\S+$/i.test(typed)) {
    // Why lowercase: GitHub identity keys are always built lowercased (repository-identity-key.ts).
    return { input, identityKey: /^github:/i.test(typed) ? wanted : typed, name: null }
  }
  throw new RuntimeClientError(
    'invalid_argument',
    `Unknown project "${typed}" on this computer. Pass its id (github:<owner>/<repo>); \`omni project list --json\` shows the ids.`
  )
}
