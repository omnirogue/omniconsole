import type {
  BuildReviewWorkspaceHold,
  BuildReviewWorkspaceHoldItem
} from '../../../shared/build-review-pipeline'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { BuildReviewRpcError, type OrchestrationCaller } from './build-review-rpc-call'
import {
  missingDispatchEvidence,
  readBuildReviewReservation,
  unresolvedBuildReviewDispatches,
  type BuildReviewReservation,
  type BuildReviewWorkspaceHeldError,
  type UnresolvedBuildReviewDispatch
} from './build-review-workspace-evidence'
import {
  clearRejectedBuildReviewWorkerStart,
  ownerDefinitelyGone,
  releaseBuildReviewWorkspace,
  type BuildReviewClaimOptions
} from './build-review-workspace-reservation'

export type BuildReviewReconcileDeps = {
  db: OrchestrationDb
  call: OrchestrationCaller
  runtimeEpoch: string
  /** The host's own answer for a terminal process; only 'exited' proves it gone. */
  processLiveness: (
    incarnation: string,
    hostScope: string | null
  ) => Promise<'live' | 'exited' | 'unverifiable'>
  /** True while that pipeline's execution still runs in this runtime. */
  isExecuting: (pipelineId: string) => boolean
}

/** What keeps a workspace reserved after reconciliation. */
export type BuildReviewHoldFacts = {
  reservation: BuildReviewReservation
  open: UnresolvedBuildReviewDispatch[]
  missingEvidence: boolean
  owner: 'run-active' | 'other-window' | null
}

const GONE_TERMINAL_CODES = new Set(['terminal_handle_stale', 'terminal_gone', 'terminal_exited'])

/** What `terminal.show` says about a terminal now. */
type ShownTerminal = {
  connected?: boolean
  ptyId?: string | null
  incarnationId?: string | null
  exitCause?: { kind: string }
  executionHostId?: string
}

/** The host process list a shown terminal belongs to, in the form worker records keep it. */
function shownHostScope(executionHostId: string | undefined): string | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return JSON.stringify({ kind: 'local', hostId: 'local' })
  }
  return host?.kind === 'ssh' ? JSON.stringify({ kind: 'ssh', targetId: host.targetId }) : null
}

/**
 * Why a shown terminal can still be gone: the runtime keeps an exited terminal readable, so
 * `terminal.show` answering is no proof its process runs. Its own exit record, or the host's
 * current process list (what a restart reads), says so; a disconnect nothing explains is not.
 */
async function shownTerminalGone(
  deps: BuildReviewReconcileDeps,
  shown: ShownTerminal | undefined
): Promise<boolean> {
  if (shown?.connected !== false) {
    return false
  }
  if (shown.exitCause && shown.exitCause.kind !== 'unknown') {
    return true
  }
  const scope = shownHostScope(shown.executionHostId)
  if (!shown.ptyId || !shown.incarnationId || !scope) {
    return false
  }
  const liveness = await deps
    .processLiveness(`${shown.ptyId}:${shown.incarnationId}`, scope)
    .catch(() => 'unverifiable' as const)
  return liveness === 'exited'
}

async function terminalGone(
  deps: BuildReviewReconcileDeps,
  entry: UnresolvedBuildReviewDispatch
): Promise<boolean> {
  if (entry.terminalReleased) {
    return true
  }
  if (entry.processIncarnation) {
    const liveness = await deps
      .processLiveness(entry.processIncarnation, entry.hostScope)
      .catch(() => 'unverifiable' as const)
    return liveness === 'exited'
  }
  return entry.terminalHandle ? terminalHandleGone(deps, entry.terminalHandle) : false
}

/** Whether a terminal is gone by the runtime's answer now; one it cannot tell about is open. */
export async function terminalHandleGone(
  deps: BuildReviewReconcileDeps,
  handle: string
): Promise<boolean> {
  let shown: { terminal?: ShownTerminal } | undefined
  try {
    shown = await deps.call<{ terminal?: ShownTerminal }>('terminal.show', { terminal: handle })
  } catch (error) {
    return error instanceof BuildReviewRpcError && GONE_TERMINAL_CODES.has(error.code)
  }
  return shownTerminalGone(deps, shown?.terminal)
}

/**
 * A worker start the owning app died inside (another runtime, its process gone) can never report
 * back, so its in-flight mark would hold the workspace for good. The existing rejected-start
 * cleanup clears it only when every Dispatch of the Run is on record, i.e. the start made none.
 */
function clearAbandonedWorkerStart(
  deps: BuildReviewReconcileDeps,
  reservation: BuildReviewReservation
): void {
  if (
    reservation.worker_start_in_flight !== 0 &&
    reservation.runtime_epoch !== deps.runtimeEpoch &&
    ownerDefinitelyGone(reservation.owner_pid)
  ) {
    clearRejectedBuildReviewWorkerStart(
      deps.db,
      reservation.workspace_key,
      reservation.pipeline_id,
      reservation.runtime_epoch
    )
  }
}

/**
 * Which Dispatches of a reserved Run no longer hold the workspace: a settled worker whose terminal
 * is released or provably gone. A worker that has not settled is never touched. With `release`
 * (a person asked), each settled worker first gets the existing `workerRelease` — the same
 * post-completion cleanup a run does itself, which keeps a terminal someone typed in — except one
 * that may still be working on its task.
 */
export async function reconcileBuildReviewDispatches(
  deps: BuildReviewReconcileDeps,
  runId: string | null,
  options: { release?: boolean } = {}
): Promise<{ resolved: Set<string>; open: UnresolvedBuildReviewDispatch[] }> {
  if (options.release) {
    // Why one at a time: each release may close a terminal; the run's own cleanup is serial too.
    for (const entry of unresolvedBuildReviewDispatches(deps.db, runId)) {
      if (entry.kind === 'terminal-open' && !entry.mayBeWorking) {
        await deps.call('orchestration.workerRelease', { dispatch: entry.id }).catch(() => null)
      }
    }
  }
  const entries = unresolvedBuildReviewDispatches(deps.db, runId)
  const gone = await Promise.all(
    entries.map(
      async (entry) => entry.kind === 'terminal-open' && (await terminalGone(deps, entry))
    )
  )
  const resolved = new Set(entries.filter((_, index) => gone[index]).map(({ id }) => id))
  return { resolved, open: entries.filter(({ id }) => !resolved.has(id)) }
}

/** Before a claim: what an earlier run in this runtime left behind that is already gone. */
export async function buildReviewClaimOptions(
  deps: BuildReviewReconcileDeps,
  workspaceKey: string
): Promise<BuildReviewClaimOptions> {
  const previous = readBuildReviewReservation(deps.db, workspaceKey)
  if (!previous) {
    return {}
  }
  clearAbandonedWorkerStart(deps, previous)
  const { resolved } = await reconcileBuildReviewDispatches(deps, previous.run_id)
  return {
    resolved,
    ownerSettled:
      previous.runtime_epoch === deps.runtimeEpoch && !deps.isExecuting(previous.pipeline_id)
  }
}

/**
 * Release the reservation on this workspace if nothing live holds it any more; `release` also
 * runs the existing worker release first. Returns what still holds it, or null once it is free.
 */
export async function releaseSettledBuildReviewWorkspace(
  deps: BuildReviewReconcileDeps,
  workspaceKey: string,
  mode: 'observe' | 'release'
): Promise<BuildReviewHoldFacts | null> {
  const current = readBuildReviewReservation(deps.db, workspaceKey)
  if (!current) {
    return null
  }
  const local = current.runtime_epoch === deps.runtimeEpoch
  if (local ? deps.isExecuting(current.pipeline_id) : !ownerDefinitelyGone(current.owner_pid)) {
    return {
      reservation: current,
      open: [],
      missingEvidence: false,
      owner: local ? 'run-active' : 'other-window'
    }
  }
  clearAbandonedWorkerStart(deps, current)
  const { resolved, open } = await reconcileBuildReviewDispatches(deps, current.run_id, {
    release: mode === 'release'
  })
  if (
    releaseBuildReviewWorkspace(
      deps.db,
      workspaceKey,
      current.pipeline_id,
      current.runtime_epoch,
      resolved
    )
  ) {
    return null
  }
  const after = readBuildReviewReservation(deps.db, workspaceKey)
  return after
    ? {
        reservation: after,
        open,
        missingEvidence: missingDispatchEvidence(deps.db, after),
        owner: null
      }
    : null
}

/** The facts a refused claim carries. */
export function heldErrorFacts(
  error: BuildReviewWorkspaceHeldError,
  runtimeEpoch: string
): BuildReviewHoldFacts {
  return {
    reservation: error.reservation,
    open: error.unresolved,
    missingEvidence: error.missingEvidence,
    owner: error.ownerLive
      ? error.reservation.runtime_epoch === runtimeEpoch
        ? 'run-active'
        : 'other-window'
      : null
  }
}

function itemKind(entry: UnresolvedBuildReviewDispatch): BuildReviewWorkspaceHoldItem['kind'] {
  if (entry.kind === 'terminal-open') {
    return entry.mayBeWorking ? 'maybe-working' : 'terminal-open'
  }
  return entry.kind === 'worker-active' ? 'worker-running' : 'unverified'
}

/** The hold as the UI shows it; `roleOf` names a Dispatch's role when its pipeline is known. */
export function buildReviewWorkspaceHold(
  facts: BuildReviewHoldFacts,
  roleOf: (dispatchId: string) => BuildReviewWorkspaceHoldItem['role']
): BuildReviewWorkspaceHold {
  const blank = { role: null, dispatchId: null, terminalHandle: null }
  const items: BuildReviewWorkspaceHoldItem[] = facts.owner ? [{ kind: facts.owner, ...blank }] : []
  for (const entry of facts.open) {
    items.push({
      kind: itemKind(entry),
      role: roleOf(entry.id),
      dispatchId: entry.id,
      terminalHandle: entry.terminalHandle,
      ...(entry.releasable ? { releasable: true } : {})
    })
  }
  if (facts.missingEvidence) {
    items.push({ kind: 'unverified', ...blank })
  }
  return {
    pipelineId: facts.reservation.pipeline_id,
    runId: facts.reservation.run_id,
    items
  }
}
