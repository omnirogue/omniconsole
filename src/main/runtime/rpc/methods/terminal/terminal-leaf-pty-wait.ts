import type { RpcContext } from '../../core'

export const TERMINAL_LEAF_PTY_WAIT_MS = 10_000
// Why a ceiling: the admission queue drains at 3 starts per 10 s, so a pending start always
// settles; the ceiling only bounds a wedged spawn so a subscriber is never parked forever.
const MAX_QUEUED_AGENT_START_WAIT_MS = 5 * 60_000

type LeafPtyWaitRuntime = Pick<RpcContext['runtime'], 'waitForLeafPtyId'> &
  Partial<Pick<RpcContext['runtime'], 'isAgentStartPendingForHandle'>>

/**
 * Waits for a subscribed terminal's PTY. The renderer mount that creates it may start an agent,
 * and that start can wait up to one admission window (10 s) even in the person lane, which is as
 * long as the plain wait — so while main still has that pane's start queued or just admitted, a
 * timed-out wait starts over instead of falling back to bare scrollback.
 */
export function waitForLeafPtyIdAllowingQueuedAgentStart(
  runtime: LeafPtyWaitRuntime,
  handle: string,
  signal: AbortSignal | undefined,
  now: () => number = Date.now
): Promise<string> {
  const deadline = now() + MAX_QUEUED_AGENT_START_WAIT_MS
  const firstWait = runtime.waitForLeafPtyId(handle, TERMINAL_LEAF_PTY_WAIT_MS, signal)
  if (typeof runtime.isAgentStartPendingForHandle !== 'function') {
    // Why the bare promise: no admission source, so the wait (and its settle timing) is unchanged.
    return firstWait
  }
  const retryWhilePending = (error: unknown): Promise<string> => {
    if (
      signal?.aborted === true ||
      now() >= deadline ||
      runtime.isAgentStartPendingForHandle?.(handle) !== true
    ) {
      throw error
    }
    return runtime
      .waitForLeafPtyId(handle, TERMINAL_LEAF_PTY_WAIT_MS, signal)
      .catch(retryWhilePending)
  }
  return firstWait.catch(retryWhilePending)
}
