// The runtime half of the stall sweep: reads the orchestration db and the pane's hook row, and
// hands both to the pure decision in worker-dispatch-stall-sweep. Kept separate so the decision
// and the join can be tested without constructing a runtime.

import { sweepWorkerDispatchStalls } from './worker-dispatch-stall-sweep'
import type { WorkerDispatchInteractiveWait } from './orchestration/worker-dispatch-stall-verdict'
import type { OrcaRuntimeService } from './omni-runtime'

/** How long one reading of a pane's interactive wait stands before the pane is read again. */
export const INTERACTIVE_WAIT_READING_FRESH_MS = 30_000

type InteractiveWaitReading = { state: WorkerDispatchInteractiveWait; at: number }

// Why a cache: the sweep is synchronous and runs at the top of every host tick, while the pane's
// interactive wait is an async reading that may reach a remote PTY. The first pass that needs it
// starts the read and keeps the dispatch (`pending`); the next pass, two seconds on, has the answer.
const readings = new WeakMap<OrcaRuntimeService, Map<string, InteractiveWaitReading>>()

function observeInteractiveWait(
  runtime: OrcaRuntimeService,
  handle: string,
  nowMs: number
): WorkerDispatchInteractiveWait {
  if (typeof runtime.getTerminalInteractiveWait !== 'function') {
    // A host that cannot read panes has no such evidence; the dispatch's own budget decides.
    return 'none'
  }
  const cache = readings.get(runtime) ?? new Map<string, InteractiveWaitReading>()
  readings.set(runtime, cache)
  const known = cache.get(handle)
  // A read that never came back is asked again after the same interval, never waited on for ever.
  if (known && nowMs - known.at <= INTERACTIVE_WAIT_READING_FRESH_MS) {
    return known.state
  }
  const settle = (state: WorkerDispatchInteractiveWait): void => {
    cache.set(handle, { state, at: nowMs })
  }
  settle('pending')
  // `undefined` (the pane could not be evaluated) is no evidence of a wait, exactly like `null`.
  void runtime
    .getTerminalInteractiveWait(handle)
    .then((wait) => settle(wait ? 'waiting' : 'none'))
    .catch(() => settle('none'))
  return 'pending'
}

/** This runtime's identity and start; undefined on a host that cannot say. */
function readRuntimeIdentity(
  runtime: OrcaRuntimeService
): { epoch: string; startedAtMs: number } | undefined {
  const epoch = typeof runtime.getRuntimeId === 'function' ? runtime.getRuntimeId() : undefined
  const startedAtMs =
    typeof runtime.getStartedAt === 'function' ? runtime.getStartedAt() : undefined
  return typeof epoch === 'string' && epoch && Number.isFinite(startedAtMs)
    ? { epoch, startedAtMs: startedAtMs as number }
    : undefined
}

/**
 * Settle every worker dispatch whose agent reported a failed turn, or which has been silent past
 * its own recorded timeout. Never throws: a watchdog that can fail the tick it runs in is worse
 * than no watchdog. Returns the number of dispatches settled, for logs and tests.
 */
export function runWorkerDispatchStallWatchdog(
  runtime: OrcaRuntimeService,
  nowMs = Date.now()
): number {
  let db
  try {
    db = runtime.getOrchestrationDb()
  } catch {
    // No orchestration db on this host: there is nothing that could have stalled.
    return 0
  }
  if (db.hasAnyDispatchContexts?.() === false) {
    return 0
  }
  try {
    const watched = db.listWatchedWorkerDispatches()
    // Readings of dispatches that settled are dropped, so the cache is bounded by what is watched.
    const cache = readings.get(runtime)
    for (const handle of cache?.keys() ?? []) {
      if (!watched.some((row) => row.agent_terminal_handle === handle)) {
        cache!.delete(handle)
      }
    }
    const settled = sweepWorkerDispatchStalls(
      {
        listWatchedWorkerDispatches: () => watched,
        failReadyWorkerDispatch: (params) => db.failReadyWorkerDispatch(params),
        observeAgentTurn: (handle) => runtime.getFreshAgentHookStatusForHandle(handle),
        observeInteractiveWait: (handle) => observeInteractiveWait(runtime, handle, nowMs),
        listSessionChains: () => runtime.listSessionChains(),
        upsertSessionChain: (chain) => runtime.upsertSessionChain(chain),
        runtime: readRuntimeIdentity(runtime)
      },
      nowMs
    )
    for (const outcome of settled) {
      console.warn('[chain-stall] failed a stalled dispatch', outcome.dispatchId, outcome.reason)
    }
    return settled.length
  } catch (error) {
    console.warn('[chain-stall] stall sweep failed', error)
    return 0
  }
}
