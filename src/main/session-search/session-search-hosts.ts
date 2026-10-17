import { z } from 'zod'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  type SessionSearchArgs,
  type SessionSearchHit,
  type SessionSearchHostStatus,
  type SessionSearchResult
} from '../../shared/session-search-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { localHostLabel } from '../local-host-label'
import { getSessionSearchService } from './session-search-service'
import { listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { remoteHitSchema } from './session-search-hit-schema'
import { searchSshSessions } from './session-search-ssh'

const REMOTE_TIMEOUT_MS = 8_000

const text = (max: number) => z.string().transform((value) => value.slice(0, max))

const remoteResultSchema = z.object({
  ownedSshCoverage: z.literal(true).optional().catch(undefined),
  hits: z.array(z.unknown()).max(SESSION_SEARCH_MAX_LIMIT),
  hosts: z
    .array(
      z
        .object({
          state: z.string(),
          hostLabel: text(300).optional(),
          executionHostId: text(600).optional(),
          message: text(2_000).optional(),
          indexedSessions: z.number().int().nonnegative().optional().catch(undefined),
          pendingFiles: z.number().int().nonnegative().optional().catch(undefined)
        })
        .passthrough()
    )
    .max(64)
    .catch([])
})

export function clampSessionSearchLimit(limit: number | undefined): number {
  return Math.min(
    SESSION_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(limit ?? SESSION_SEARCH_DEFAULT_LIMIT))
  )
}

async function searchLocal(
  query: string,
  limit: number
): Promise<{ hits: SessionSearchHit[]; host: SessionSearchHostStatus }> {
  const hostLabel = localHostLabel()
  const service = getSessionSearchService()
  if (!service) {
    return {
      hits: [],
      host: {
        hostLabel,
        executionHostId: 'local',
        state: 'unsupported',
        message: 'Content search is turned off on this computer.'
      }
    }
  }
  try {
    const value = await service.search(query, limit)
    return {
      hits: value.hits.map((hit) => ({ ...hit, hostLabel, executionHostId: 'local' })),
      host: {
        hostLabel,
        executionHostId: 'local',
        state: value.passes === 0 ? 'indexing' : 'searched',
        indexedSessions: value.indexedSessions,
        pendingFiles: value.pendingFiles
      }
    }
  } catch (error) {
    return {
      hits: [],
      host: {
        hostLabel,
        executionHostId: 'local',
        state: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

async function searchRemote(
  userDataPath: string,
  environment: { id: string; name: string },
  query: string,
  limit: number
): Promise<{
  hits: SessionSearchHit[]
  host: SessionSearchHostStatus
  ownedSsh?: SessionSearchHostStatus[]
}> {
  const executionHostId = `runtime:${environment.id}`
  const base = { hostLabel: environment.name, executionHostId }
  try {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environment.id,
      'sessionSearch.query',
      { query, limit, includeRemote: false, includeOwnedSsh: true },
      REMOTE_TIMEOUT_MS
    )
    if (!response.ok) {
      const unsupported = response.error.code === 'method_not_found'
      return {
        hits: [],
        host: {
          ...base,
          state: unsupported ? 'unsupported' : 'failed',
          message: unsupported
            ? 'OmniConsole on this host is older than content search; update it to search there.'
            : response.error.message
        }
      }
    }
    const validated = remoteResultSchema.safeParse(response.result)
    if (!validated.success) {
      return {
        hits: [],
        host: { ...base, state: 'failed', message: 'The host returned an invalid search result.' }
      }
    }
    const parsed = validated.data
    const hits = parsed.hits.flatMap((raw) => {
      const hit = remoteHitSchema.safeParse(raw)
      return hit.success &&
        (hit.data.executionHostId === undefined || hit.data.executionHostId === 'local')
        ? [{ ...hit.data, hostLabel: environment.name, executionHostId }]
        : []
    })
    const localHosts = parsed.hosts.filter((host) => host.executionHostId === 'local')
    const remoteHost =
      localHosts.length === 1
        ? localHosts[0]
        : parsed.hosts.length === 1 && parsed.hosts[0]?.executionHostId === undefined
          ? parsed.hosts[0]
          : undefined
    const state = remoteHost?.state
    const reportedState =
      state === 'searched' ||
      state === 'indexing' ||
      state === 'unsupported' ||
      state === 'unreachable' ||
      state === 'failed'
        ? state
        : undefined
    return {
      hits,
      ownedSsh: pairedSshCoverage(environment, parsed),
      host: {
        ...base,
        state: reportedState ?? 'failed',
        ...(reportedState
          ? { message: remoteHost?.message }
          : { message: 'The host did not report verifiable search coverage.' }),
        indexedSessions: remoteHost?.indexedSessions,
        pendingFiles: remoteHost?.pendingFiles
      }
    }
  } catch (error) {
    // Loss of contact says nothing about the host's sessions: report it, never as "no matches".
    return {
      hits: [],
      host: {
        ...base,
        state: 'unreachable',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

function pairedSshCoverage(
  environment: { id: string; name: string },
  result: z.infer<typeof remoteResultSchema>
): SessionSearchHostStatus[] {
  const incomplete = (message: string): SessionSearchHostStatus[] => [
    {
      hostLabel: environment.name,
      executionHostId: `runtime:${environment.id}`,
      ownerEnvironmentId: environment.id,
      coverage: 'owned-ssh',
      state: 'unsupported',
      message
    }
  ]
  if (result.ownedSshCoverage !== true) {
    return incomplete(
      'This controller did not report its SSH targets. Update it to verify their search coverage.'
    )
  }
  const seen = new Set<string>()
  const rows: SessionSearchHostStatus[] = []
  for (const host of result.hosts) {
    if (host.executionHostId === 'local') {
      continue
    }
    const parsed = parseExecutionHostId(host.executionHostId)
    if (parsed?.kind !== 'ssh' || seen.has(parsed.targetId)) {
      return incomplete('This controller returned invalid or ambiguous SSH coverage.')
    }
    seen.add(parsed.targetId)
    const state = host.state
    rows.push({
      hostLabel: `${host.hostLabel || parsed.targetId} (via ${environment.name})`,
      executionHostId: parsed.id,
      ownerEnvironmentId: environment.id,
      coverage: 'owned-ssh',
      // This request carries coverage only; content from these targets was not queried.
      state: state === 'unreachable' ? 'unreachable' : 'unsupported',
      message: host.message || 'SSH transcripts on this controller were not searched.'
    })
  }
  return rows
}

/** Search available indexes and explicitly report hosts whose transcripts are outside coverage. */
export async function searchSessionsOnHosts(
  userDataPath: string,
  args: SessionSearchArgs
): Promise<SessionSearchResult> {
  const started = Date.now()
  const query = args.query.trim()
  const limit = clampSessionSearchLimit(args.limit)
  const environments = args.includeRemote === false ? [] : listEnvironments(userDataPath)
  const sshTargets =
    args.includeRemote === false && !args.includeOwnedSsh ? [] : listRegisteredSshTargets()
  const results = await Promise.all([
    searchLocal(query, limit),
    ...environments.map((environment) => searchRemote(userDataPath, environment, query, limit)),
    ...sshTargets.map((target) =>
      searchSshSessions(target, query, limit, args.includeRemote === false)
    )
  ])
  const hits = results
    .flatMap((result) => result.hits)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
  return {
    query,
    hits,
    hosts: results.flatMap((result) => [
      result.host,
      ...('ownedSsh' in result ? (result.ownedSsh ?? []) : [])
    ]),
    tookMs: Date.now() - started,
    ...(args.includeOwnedSsh ? { ownedSshCoverage: true as const } : {})
  }
}
