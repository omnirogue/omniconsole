import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'
import { coalescedWriteDelay } from '../../coalesced-state-write'

const SAVE_DEBOUNCE_MS = 1_000
const SAVE_MAX_WAIT_MS = 5_000
// Why: each save rewrites the whole multi-MB omni-data.json; renderer session churn scheduled
// one every few seconds (#857). A few prompt saves pass, then at most 2/min under churn.
// Durability barriers (flushOrThrow, async barriers) bypass this budget.
export const PRIMARY_STATE_WRITE_BURST = 4
export const PRIMARY_STATE_WRITE_REFILL_MS = 30_000

type WriteSchedulingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'firstPendingSaveAt'
  | 'pendingWrite'
  | 'primaryWriteBudget'
  | 'quitFlushStarted'
  | 'writeGeneration'
  | 'writeTimer'
>

const writeSchedulingOperationsContext = Symbol('WriteSchedulingOperations')
type WriteSchedulingOperationsContext = {
  runtime: WriteSchedulingOperationsRuntime
  writes: PrimaryStateWriteOperations
}

export class WriteSchedulingOperations {
  readonly [writeSchedulingOperationsContext]: WriteSchedulingOperationsContext

  constructor(runtime: WriteSchedulingOperationsRuntime, writes: PrimaryStateWriteOperations) {
    this[writeSchedulingOperationsContext] = { runtime, writes }
  }

  async waitForPendingWrite(): Promise<void> {
    await Promise.all([
      this[writeSchedulingOperationsContext].runtime.pendingWrite,
      this[writeSchedulingOperationsContext].runtime.activeViewPreference.waitForPendingWrite()
    ])
  }
}

export function scheduleSave(owner: WriteSchedulingOperations): void {
  owner[writeSchedulingOperationsContext].runtime.automationListProjectionCache = null
  // Why: once the quit flush has snapshotted, a newly debounced write would fire during
  // teardown with nothing awaiting it, and the process can exit mid-rename. The quit
  // flush is the last write by construction.
  if (owner[writeSchedulingOperationsContext].runtime.quitFlushStarted) {
    return
  }
  owner[writeSchedulingOperationsContext].runtime.writeGeneration += 1
  const now = Date.now()
  owner[writeSchedulingOperationsContext].runtime.firstPendingSaveAt ??= now
  if (owner[writeSchedulingOperationsContext].runtime.writeTimer) {
    clearTimeout(owner[writeSchedulingOperationsContext].runtime.writeTimer)
  }
  const delay = coalescedWriteDelay({
    now,
    firstPendingAt: owner[writeSchedulingOperationsContext].runtime.firstPendingSaveAt,
    debounceMs: SAVE_DEBOUNCE_MS,
    maxWaitMs: SAVE_MAX_WAIT_MS,
    budgetWaitMs: owner[writeSchedulingOperationsContext].runtime.primaryWriteBudget.waitMs(now)
  })
  owner[writeSchedulingOperationsContext].runtime.writeTimer = setTimeout(() => {
    owner[writeSchedulingOperationsContext].runtime.writeTimer = null
    owner[writeSchedulingOperationsContext].runtime.firstPendingSaveAt = null
    // Why: the budget token is spent in writeToDiskAsync after a successful rename, so no-op and
    // abandoned writes don't burn it. An abandoned write always has a newer timer from scheduleSave
    // (or a sync flush that already wrote fresher state).
    void enqueueWrite(owner[writeSchedulingOperationsContext].writes)
  }, delay)
}

export function installWriteSchedulingOperationsContext(
  target: object,
  source: WriteSchedulingOperations
): void {
  Object.defineProperty(target, writeSchedulingOperationsContext, {
    value: source[writeSchedulingOperationsContext]
  })
}
