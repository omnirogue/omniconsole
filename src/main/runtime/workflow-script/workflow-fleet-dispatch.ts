import { randomBytes } from 'node:crypto'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import type {
  WorkflowPlacement,
  WorkflowPlacementDispatch
} from '../../../shared/local-workflow-placement'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import { localWorkflowProviderLabel } from '../../../shared/local-workflow-model-label'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  parseWorkflowFleetProbe,
  workflowFleetHiddenPaths,
  workflowFleetProbeScript,
  workflowFleetRouteProblem,
  WORKFLOW_FLEET_SEAT_ROUTES,
  type WorkflowFleetSeatRoute
} from './workflow-fleet-host-probe'
import {
  workflowFleetFailure,
  workflowFleetShellQuote,
  workflowFleetSsh
} from './workflow-fleet-remote-shell'
import { copyWorkflowFleetWorkspace } from './workflow-fleet-workspace-copy'

import {
  discardWorkflowFleetDispatch,
  workflowFleetSweepScript,
  WORKFLOW_FLEET_RUNS_FOLDER
} from './workflow-fleet-retention'
export { WORKFLOW_FLEET_RUNS_FOLDER } from './workflow-fleet-retention'
const PROBE_TIMEOUT_MS = 30_000

export type WorkflowFleetDispatchDeps = {
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
  /** The run folder's name on the host; tests fix it. */
  id?: () => string
  /** Where the workspace archive is built before it is copied. */
  tmp?: string
}

function seatRoutes(snapshot: LocalWorkflowHostSnapshot): LocalWorkflowRoute[] {
  return [...new Set(snapshot.seats.map((seat) => seat.agent))]
}

/**
 * Readies a `dispatched-seats` host before the run is admitted, or refuses it by name: every
 * seat is Claude or Codex, each CLI is new enough and signed in with a subscription on the host
 * (API key variables unset), the run's folder exists there, and a run that reads files has its
 * frozen copy there. Returns the placement with `dispatch` set; nothing runs on this computer.
 */
export async function readyWorkflowFleetDispatch(
  placement: WorkflowPlacement,
  snapshot: LocalWorkflowHostSnapshot,
  deps: WorkflowFleetDispatchDeps = {}
): Promise<WorkflowPlacement> {
  const host = placement.host?.name
  const alias = placement.host?.ssh
  if (placement.mode !== 'dispatched-seats' || !host || !alias) {
    throw new Error('This placement has no host to dispatch seats to.')
  }
  const routes = seatRoutes(snapshot)
  const other = routes.filter(
    (route) => !(WORKFLOW_FLEET_SEAT_ROUTES as readonly string[]).includes(route)
  )
  if (other.length) {
    throw new Error(
      `Seats on ${host} run Claude and Codex on its own subscription logins; ${other.map(localWorkflowProviderLabel).join(' and ')} cannot run there. Choose Claude and Codex seats, or 'this computer'.`
    )
  }
  // A command check runs in this workspace (graph-check.ts); it never moves here silently.
  const spec = snapshot.graph?.spec
  if (spec?.repeat?.check || spec?.find?.check || snapshot.host.checkSource) {
    throw new Error(
      `This run checks each version with a command in this computer's workspace, which cannot run on ${host} in this build. Choose 'this computer' to run here.`
    )
  }
  const fleetRoutes = routes as WorkflowFleetSeatRoute[]
  const probed = await workflowFleetSsh(
    deps,
    alias,
    workflowFleetProbeScript(fleetRoutes),
    PROBE_TIMEOUT_MS
  )
  const facts =
    probed && probed.code === 0 && !probed.timedOut
      ? parseWorkflowFleetProbe(probed.stdout)
      : undefined
  if (!facts) {
    throw new Error(workflowFleetFailure(host, 'report its CLIs and logins', probed))
  }
  const problems = fleetRoutes
    .map((route) =>
      workflowFleetRouteProblem(
        host,
        route,
        facts,
        snapshot.seats.filter((seat) => seat.agent === route).map((seat) => seat.model)
      )
    )
    .filter((problem): problem is string => !!problem)
  if (problems.length) {
    throw new Error(`${problems.join(' ')} Choose another host, or 'this computer'.`)
  }
  const swept = await workflowFleetSsh(
    deps,
    alias,
    workflowFleetSweepScript(facts.home),
    PROBE_TIMEOUT_MS
  )
  if (swept?.code !== 0) {
    throw new Error(workflowFleetFailure(host, 'sweep finished run folders', swept))
  }
  const id = deps.id?.() ?? `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
  const root = `${facts.home}/${WORKFLOW_FLEET_RUNS_FOLDER}/${id}`
  const dispatch: WorkflowPlacementDispatch = {
    root,
    home: facts.home,
    hidden: workflowFleetHiddenPaths(facts)
  }
  try {
    const made = await workflowFleetSsh(
      deps,
      alias,
      `umask 077 && mkdir -p ${workflowFleetShellQuote(`${root}/attempts`)} && printf made`,
      PROBE_TIMEOUT_MS
    )
    if (!made || made.code !== 0 || made.stdout.trim() !== 'made') {
      throw new Error(workflowFleetFailure(host, "create the run's folder", made))
    }
    const readable =
      snapshot.access === 'workspace-read' ? snapshot.host.workspaceRoot?.path : undefined
    if (snapshot.access === 'workspace-read' && !readable) {
      throw new Error('This run reads files but has no frozen folder to copy to the host.')
    }
    if (readable) {
      dispatch.workspace = await copyWorkflowFleetWorkspace(
        { host, alias, root: readable, target: `${root}/workspace` },
        deps
      )
    }
  } catch (error) {
    try {
      await discardWorkflowFleetDispatch({ ...placement, dispatch }, deps)
    } catch (cleanup) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ${String(cleanup)}`,
        { cause: error }
      )
    }
    throw error
  }
  return { ...placement, dispatch }
}
