// ─── The sweep that ends the silence ─────────────────────────────────────────
// Why: a step's agent can die in two ways nobody was listening for. It can SAY so (Claude's
// StopFailure — a quota wall nine seconds after the prompt landed), or it can say nothing at all
// while its dispatch sits `ready`/`input_accepted` forever. The first needed a failure the hook
// pipeline never carried; the second needed someone to enforce the `timeoutMs` every worker-start
// already recorded. Both end here, in one pass, so no stall depends on a hook existing.

import type { SessionChain, SessionChainStep } from '../../shared/session-chain-types'
import { isSessionChainAgentStep } from '../../shared/session-chain-types'
import { isEquivalentPaneKey } from './orchestration/db/pane-key-match'
import {
  isWorkerDispatchStallVerdict,
  judgeWorkerDispatchStall,
  type WorkerDispatchInteractiveWait,
  type WorkerDispatchStallObservation
} from './orchestration/worker-dispatch-stall-verdict'
import type { WatchedWorkerDispatchRow } from './orchestration/db/worker-dispatch/worker-dispatch-stall'

export type WorkerDispatchStallSweepDeps = {
  listWatchedWorkerDispatches: () => WatchedWorkerDispatchRow[]
  failReadyWorkerDispatch: (params: {
    dispatchId: string
    stage: string
    reason: string
  }) => { dispatch_id: string } | null
  /** The pane's fresh hook row for a worker terminal, or null when there is none. */
  observeAgentTurn: (terminalHandle: string) => WorkerDispatchStallObservation
  /**
   * Whether the worker's pane is visibly parked on an interactive prompt. Asked only for a
   * dispatch that silence alone would fail; absent on a host that cannot read panes.
   */
  observeInteractiveWait?: (terminalHandle: string) => WorkerDispatchInteractiveWait
  listSessionChains: () => SessionChain[]
  upsertSessionChain: (chain: SessionChain) => unknown
  /**
   * This runtime's identity and when it began observing hooks. A worker started by another
   * runtime (a restart) is not charged for silence from before this one could see it.
   */
  runtime?: { epoch: string; startedAtMs: number }
}

export type WorkerDispatchStallSweepOutcome = {
  dispatchId: string
  reason: string
  /** Chains whose step this failure was joined to. Empty when nothing claimed the pane. */
  chainIds: string[]
}

function failStepInChain(
  chain: SessionChain,
  paneKey: string,
  reason: string
): SessionChain | null {
  let matched = false
  const steps: SessionChainStep[] = chain.steps.map((step) => {
    if (
      matched ||
      !isSessionChainAgentStep(step) ||
      step.status === 'failed' ||
      typeof step.launchedPaneKey !== 'string' ||
      !isEquivalentPaneKey(step.launchedPaneKey, paneKey)
    ) {
      return step
    }
    matched = true
    return { ...step, status: 'failed' }
  })
  if (!matched) {
    return null
  }
  // Why: `error` is what the sidebar's existing banner reads, and `failed` is what stops the row
  // reading as "waiting" for work that already died. Nothing else about the record is touched.
  return { ...chain, steps, state: 'failed', error: reason }
}

/**
 * Join a failed dispatch to the step that owns its pane and fail that step. Outcome-bound chains
 * are deliberately skipped: their record is owned by the host executor behind a revision fence,
 * and its own tick turns this dispatch's `last_error` into the outcome's blocked reason (which is
 * what fills `chain.error` for them). Writing them from here would race that owner.
 */
function failJoinedChainSteps(
  deps: WorkerDispatchStallSweepDeps,
  paneKey: string | null,
  reason: string
): string[] {
  if (!paneKey) {
    return []
  }
  const failed: string[] = []
  for (const chain of deps.listSessionChains()) {
    if (chain.outcomeSet) {
      continue
    }
    const next = failStepInChain(chain, paneKey, reason)
    if (!next) {
      continue
    }
    try {
      deps.upsertSessionChain(next)
      failed.push(chain.id)
    } catch (error) {
      console.warn('[chain-stall] could not record a failed step', chain.id, error)
    }
  }
  return failed
}

/** Only a recorded, different runtime proves a restart; an unrecorded one is judged as before. */
function startedBeforeThisRuntime(
  row: WatchedWorkerDispatchRow,
  deps: WorkerDispatchStallSweepDeps
): boolean {
  return Boolean(deps.runtime && row.runtime_epoch && row.runtime_epoch !== deps.runtime.epoch)
}

/** One pass over every dispatch whose worker still owns its turn. Returns what it settled. */
export function sweepWorkerDispatchStalls(
  deps: WorkerDispatchStallSweepDeps,
  nowMs = Date.now()
): WorkerDispatchStallSweepOutcome[] {
  const settled: WorkerDispatchStallSweepOutcome[] = []
  for (const row of deps.listWatchedWorkerDispatches()) {
    const updatedAtMs = Date.parse(row.updated_at)
    if (!Number.isFinite(updatedAtMs)) {
      // An unreadable timestamp is not evidence of a stall.
      continue
    }
    const observation = row.agent_terminal_handle
      ? deps.observeAgentTurn(row.agent_terminal_handle)
      : null
    const heartbeatAtMs = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : Number.NaN
    const subject = {
      dispatchId: row.dispatch_id,
      stage: row.stage,
      updatedAtMs,
      timeoutMs: row.timeout_ms,
      heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
      observedSinceMs: startedBeforeThisRuntime(row, deps) ? deps.runtime!.startedAtMs : null
    }
    let verdict = judgeWorkerDispatchStall(subject, observation, nowMs)
    if (
      isWorkerDispatchStallVerdict(verdict) &&
      row.agent_terminal_handle &&
      deps.observeInteractiveWait
    ) {
      // The screen is read only for a dispatch about to be failed on silence, never for every row.
      verdict = judgeWorkerDispatchStall(
        subject,
        observation,
        nowMs,
        deps.observeInteractiveWait(row.agent_terminal_handle)
      )
    }
    if (verdict.kind !== 'fail') {
      continue
    }
    const worker = deps.failReadyWorkerDispatch({
      dispatchId: row.dispatch_id,
      stage: verdict.stage,
      reason: verdict.reason
    })
    if (!worker) {
      // Someone else settled it in the same instant; their outcome is the truth.
      continue
    }
    settled.push({
      dispatchId: row.dispatch_id,
      reason: verdict.reason,
      chainIds: failJoinedChainSteps(deps, row.assignee_pane_key, verdict.reason)
    })
  }
  return settled
}
