import os from 'node:os'
import {
  evolveSpecPath,
  EVOLVE_DEFAULT_CHECKOUT,
  type EvolveStartRequest
} from '../../../shared/evolve-workflow'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import { shortWorkflowHostname } from '../workflow-script/local-workflow-fleet-hosts'
import {
  placeLocalWorkflow,
  WorkflowFleetPlacementRefusal,
  type WorkflowFleetPlacementDeps
} from '../workflow-script/local-workflow-fleet-placement'
import {
  evolveNoAnswer,
  evolveReadinessProblem,
  evolveReadinessScript,
  runEvolveHostScript,
  type EvolveHostDeps,
  type EvolveHostTarget
} from './evolve-host-commands'
import {
  resolveHostedEvolveBearerToken,
  type HostedEvolveClientDeps
} from './hosted-evolve-client'

export type EvolveAdmissionDeps = EvolveHostDeps & {
  placement?: WorkflowFleetPlacementDeps
  place?: typeof placeLocalWorkflow
  platform?: NodeJS.Platform
  /** `user@host` a person's run is submitted as when the form leaves it blank. */
  localIdentity?: () => string
  hosted?: HostedEvolveClientDeps
}

export type EvolveAdmission = {
  placement: WorkflowPlacement
  target: EvolveHostTarget
  checkout: string
  spec: string
  submittedBy: string
}

const LOCAL_NAME = 'this computer'
export const HOSTED_EVOLVE_HOST_NAME = 'Omnisi Cloud'

function localIdentity(): string {
  let user = 'unknown'
  try {
    user = os.userInfo().username
  } catch {
    // Some containers have no passwd entry; the host name still says where it came from.
  }
  return `${user}@${shortWorkflowHostname(os.hostname())}`
}

/** Where the jev-lab CLI runs for a frozen placement; a fleet host is reached by its SSH alias. */
export function evolveHostTarget(placement: WorkflowPlacement): EvolveHostTarget | undefined {
  if (placement.mode === 'local') {
    return { kind: 'local', name: LOCAL_NAME }
  }
  if (placement.mode === 'remote-runtime' && !placement.host?.ssh && placement.host?.name) {
    return { kind: 'hosted', name: placement.host.name }
  }
  return placement.host?.ssh
    ? { kind: 'ssh', alias: placement.host.ssh, name: placement.host.name }
    : undefined
}

/**
 * The fleet decides as for any workflow (docs/reference/workflow-fleet-placement.md). A host
 * whose runtime has account services is still reached over SSH: the worker is one process there,
 * not a run handed to that runtime, so the refusal other workflows give does not apply.
 */
async function placeEvolveRun(
  request: EvolveStartRequest,
  deps: EvolveAdmissionDeps
): Promise<WorkflowPlacement> {
  const pick = request.runsOnHost
    ? {
        host: request.runsOnHost,
        ...(request.runsOnHostId ? { hostId: request.runsOnHostId } : {}),
        ...(request.forceHost ? { forceReason: request.forceHost } : {})
      }
    : undefined
  try {
    return await (deps.place ?? placeLocalWorkflow)(
      request.runsOn === 'local' ? 'local' : 'fleet',
      deps.placement ?? {},
      pick
    )
  } catch (error) {
    const placement = error instanceof WorkflowFleetPlacementRefusal ? error.placement : undefined
    if (placement?.mode === 'remote-runtime' && placement.host?.ssh) {
      return { ...placement, mode: 'dispatched-seats' }
    }
    throw error
  }
}

/**
 * Everything a Start is refused for, by name, before anything is written or submitted: the
 * placement, a platform without a POSIX shell, and a host that cannot run the spec (no
 * checkout, venv or spec there, or Claude not signed in over SSH).
 */
export async function admitEvolveRun(
  request: EvolveStartRequest,
  caller: { agent: boolean },
  deps: EvolveAdmissionDeps = {}
): Promise<EvolveAdmission> {
  const checkout = request.checkout ?? EVOLVE_DEFAULT_CHECKOUT
  const spec = evolveSpecPath(request)
  const submittedBy =
    request.submittedBy ??
    (caller.agent ? request.requestedBy : undefined) ??
    (deps.localIdentity ?? localIdentity)()

  if (request.runsOn === 'hosted') {
    const token = await resolveHostedEvolveBearerToken(deps.hosted?.leaseToken)
    if (!token) {
      throw new Error(
        'Connect your OmniRogue account in Settings before running Hosted Super Intelligence.'
      )
    }

    const placement: WorkflowPlacement = {
      runsOn: 'fleet',
      mode: 'remote-runtime',
      choice: 'named',
      hostId: 'hosted:omnisi-cloud',
      host: {
        name: HOSTED_EVOLVE_HOST_NAME,
        machine: 'omnisi-cloud',
        cores: 1,
        loadPerCore: 0,
        readAt: Date.now()
      }
    }
    return {
      placement,
      target: { kind: 'hosted', name: HOSTED_EVOLVE_HOST_NAME },
      checkout,
      spec,
      submittedBy
    }
  }
  const placement = await placeEvolveRun(request, deps)
  const target = evolveHostTarget(placement)
  if (!target) {
    throw new Error(`${placement.host?.name ?? 'The chosen host'} has no SSH alias to reach it by.`)
  }
  if (target.kind === 'local' && (deps.platform ?? process.platform) === 'win32') {
    throw new Error(
      "Evolve runs jev-lab's CLI in a POSIX shell, which this Windows computer does not have. Choose a fleet host."
    )
  }
  const result = await runEvolveHostScript(
    deps,
    target,
    evolveReadinessScript(checkout, spec),
    30_000
  )
  const unanswered = evolveNoAnswer(target.name, 'check that it can run Evolve', result)
  if (unanswered || !result) {
    throw new Error(unanswered)
  }
  const problem = evolveReadinessProblem(target.name, checkout, spec, result.stdout)
  if (problem) {
    throw new Error(problem)
  }
  return { placement, target, checkout, spec, submittedBy }
}
