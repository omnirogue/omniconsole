/**
 * Reads every computer a launch can go to — this one, each paired OmniConsole, and each SSH target
 * registered here — for `omni host list --capacity` and `omni session launch --project`
 * (docs/reference/agent-launch.md). Read-only and bounded: three at a time within 45 s. A computer
 * that does not answer in time is unverifiable, never idle and never 0%.
 */

import {
  LAUNCH_PLACEMENT_CONCURRENCY,
  LAUNCH_PLACEMENT_DEADLINE_MS,
  type LaunchCandidate,
  type LaunchCapacityAccounts,
  type LaunchPlacementProject,
  type LaunchPlacementRoute
} from '../shared/agent-launch-placement-types'
import { mapSettledWithConcurrency } from '../shared/map-with-concurrency'
import type { CapacityProvider } from '../shared/provider-account-capacity'
import type { EnvironmentSummary, SshTargetSummary } from './host-selector-alternatives'
import {
  candidateReadFailure,
  readCandidateListedAccounts,
  readCandidateReadiness,
  readCandidateSetups,
  readCandidateStatus,
  type LaunchRpcClient
} from './launch-candidate-reads'
import {
  classifyLaunchCandidate,
  type LaunchSetupsRead,
  type LaunchStatusRead
} from './launch-candidate-state'
import { RuntimeClientError } from './runtime/types'

export { resolveLaunchProject, type LaunchRpcClient } from './launch-candidate-reads'

export type LaunchCandidateReaderDeps = {
  now: () => number
  /** This computer's own runtime; it also drives every SSH route. */
  local: LaunchRpcClient
  /** One client per paired computer: `new RuntimeClient(undefined, t, null, environmentId)`. */
  environment: (environmentId: string) => LaunchRpcClient
  environments: readonly EnvironmentSummary[]
  /** SSH targets registered on this computer. */
  listSshTargets: () => Promise<SshTargetSummary[]>
}

export type LaunchCandidateQuery = {
  provider: CapacityProvider
  model: string | null
  /** Null for the capacity view without --project. */
  project: LaunchPlacementProject | null
  /** The capacity view also reads older runtimes' accounts read-only; placement skips them. */
  readOldRuntimeAccounts: boolean
  /** `--project` with `--host`: read only that computer's routes. */
  only?: (route: LaunchPlacementRoute) => boolean
}

export type LaunchCandidateReading = {
  candidate: LaunchCandidate
  /** `accounts.list`, read-only, where readiness was not asked (older runtime, no setup). */
  listedAccounts: LaunchCapacityAccounts | null
}

type RouteJob = {
  route: LaunchPlacementRoute
  label: string
  isThisComputer: boolean
  read: () => Promise<LaunchCandidateReading>
}

async function readRoute(
  job: Omit<RouteJob, 'read'>,
  client: LaunchRpcClient,
  reads: { status: LaunchStatusRead; setups: LaunchSetupsRead },
  query: LaunchCandidateQuery,
  now: () => number
): Promise<LaunchCandidateReading> {
  const facts = { ...job, ...reads, ...query, readiness: null, checkedAt: now() }
  const unasked = classifyLaunchCandidate(facts)
  // Why readiness only then: it resolves the setup with the launch's own resolver and previews
  // that computer's own pick, so without the capability or a ready setup there is nothing to ask.
  if (unasked.launchCapability && unasked.setup) {
    const readiness = await readCandidateReadiness(client, unasked.setup.selector, query)
    return {
      candidate: classifyLaunchCandidate({ ...facts, readiness, checkedAt: now() }),
      listedAccounts: null
    }
  }
  const listed = query.readOldRuntimeAccounts && reads.status.ok && job.route.kind !== 'ssh'
  return {
    candidate: unasked,
    listedAccounts: listed ? await readCandidateListedAccounts(client, query, now) : null
  }
}

function unverifiableReading(
  job: RouteJob,
  query: LaunchCandidateQuery,
  reason: string,
  now: number
): LaunchCandidateReading {
  return {
    candidate: classifyLaunchCandidate({
      ...job,
      ...query,
      checkedAt: now,
      status: { ok: false, reason },
      setups: { ok: false, unsupported: false, reason },
      readiness: null
    }),
    listedAccounts: null
  }
}

type CallOptions = Parameters<LaunchRpcClient['call']>[2]

/**
 * Why: a read cut off by the deadline is abandoned, not cancelled, so its follow-up calls must not
 * go out late or outlive the deadline and keep the command running after it prints.
 */
function deadlineBoundClient(
  client: LaunchRpcClient,
  deadlineAt: number,
  now: () => number
): LaunchRpcClient {
  return {
    call: <TResult>(method: string, params?: unknown, options?: CallOptions) => {
      const remaining = deadlineAt - now()
      if (remaining <= 0) {
        return Promise.reject(
          new RuntimeClientError(
            'runtime_timeout',
            `Not sent: past the ${LAUNCH_PLACEMENT_DEADLINE_MS / 1000} s overall deadline.`
          )
        )
      }
      return client.call<TResult>(method, params, {
        ...options,
        timeoutMs: Math.min(options?.timeoutMs ?? remaining, remaining)
      })
    }
  }
}

async function withinDeadline(
  job: RouteJob,
  query: LaunchCandidateQuery,
  deadlineAt: number,
  now: () => number
): Promise<LaunchCandidateReading> {
  const late = (): LaunchCandidateReading =>
    unverifiableReading(
      job,
      query,
      `did not answer within the ${LAUNCH_PLACEMENT_DEADLINE_MS / 1000} s overall deadline (unverifiable)`,
      now()
    )
  const remaining = deadlineAt - now()
  if (remaining <= 0) {
    return late()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<LaunchCandidateReading>((resolve) => {
    timer = setTimeout(() => resolve(late()), remaining)
  })
  try {
    return await Promise.race([job.read(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Every route as a candidate, in order: this computer, paired computers, then SSH targets. */
export async function readLaunchCandidates(
  query: LaunchCandidateQuery,
  deps: LaunchCandidateReaderDeps
): Promise<LaunchCandidateReading[]> {
  const deadlineAt = deps.now() + LAUNCH_PLACEMENT_DEADLINE_MS
  const bound = (client: LaunchRpcClient) => deadlineBoundClient(client, deadlineAt, deps.now)
  const localClient = bound(deps.local)
  const [localStatus, localSetups, sshTargets] = await Promise.all([
    readCandidateStatus(localClient),
    readCandidateSetups(localClient),
    deps.listSshTargets().catch((): SshTargetSummary[] => [])
  ])
  const local = { status: localStatus, setups: localSetups }
  const job = (
    route: LaunchPlacementRoute,
    label: string,
    read: (base: Omit<RouteJob, 'read'>) => Promise<LaunchCandidateReading>
  ): RouteJob => {
    const base = { route, label, isThisComputer: route.kind === 'local' }
    return { ...base, read: () => read(base) }
  }
  const routes: RouteJob[] = [
    job({ kind: 'local' }, 'this computer', (base) =>
      readRoute(base, localClient, local, query, deps.now)
    ),
    ...deps.environments.map((environment) =>
      job(
        { kind: 'environment', environmentId: environment.id, name: environment.name },
        environment.name,
        async (base) => {
          const client = bound(deps.environment(environment.id))
          const [status, setups] = await Promise.all([
            readCandidateStatus(client),
            readCandidateSetups(client)
          ])
          return readRoute(base, client, { status, setups }, query, deps.now)
        }
      )
    ),
    ...sshTargets.map((target) =>
      job({ kind: 'ssh', targetId: target.id, label: target.label }, target.label, (base) =>
        readRoute(base, localClient, local, query, deps.now)
      )
    )
  ]
  const jobs = routes.filter((entry) => query.only?.(entry.route) ?? true)
  const settled = await mapSettledWithConcurrency(jobs, LAUNCH_PLACEMENT_CONCURRENCY, (entry) =>
    withinDeadline(entry, query, deadlineAt, deps.now)
  )
  return settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : unverifiableReading(
          jobs[index]!,
          query,
          candidateReadFailure(result.reason, LAUNCH_PLACEMENT_DEADLINE_MS).reason,
          deps.now()
        )
  )
}
