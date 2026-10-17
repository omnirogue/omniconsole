import type { RpcRequest } from '../rpc/core'

export const KEEPALIVE_INTERVAL_MS = 10_000

// Why: cap long-polls at half the 32-slot connection budget so they can't starve short RPCs; overflow → runtime_busy. See §7 risk #2.
export const LONG_POLL_CAP = 16

// Why: orchestration.ask blocks on a human/agent reply for minutes, an order of
// magnitude longer than terminal.wait or check --wait, so a fleet of asking
// workers would otherwise hold every slot and starve the mobile/web/CLI/relay
// clients sharing this runtime. Reserve half the budget for the other classes.
export const ASK_LONG_POLL_SHARE = 0.5
// Why: eight host slots preserve four-host overlap for two independently paired desktops.
export const BROWSER_HOST_LONG_POLL_SHARE = 0.5
// Why: asks and permanent hosts together retain the prior quarter-budget reservation for waits.
export const SPECIALIZED_LONG_POLL_SHARE = 0.75

// Why: 'ask' is metered separately from 'wait' — same keepalive/abort wiring, its own sub-cap.
export type RuntimeLongPollClass = 'ask' | 'browser-host' | 'wait'

// Why: single classifier for long-poll requests (handlers that block on an external event), shared by counter/abort/keepalive. See §3.1.
export function classifyRuntimeLongPoll(request: RpcRequest): RuntimeLongPollClass | null {
  // Worker start waits for readiness and then verifies the submitted prompt;
  // the complete operation can run for 90–110s. Keep every local transport
  // (Unix sockets and Windows named pipes) alive for that long poll.
  if (request.method === 'orchestration.workerStart') {
    return 'wait'
  }
  if (request.method === 'browser.clientHost.attach') {
    return 'browser-host'
  }
  if (request.method === 'terminal.wait') {
    return 'wait'
  }
  // Agent-prompt submission waits for the PTY's lifecycle transition (up to
  // the verification budget); keep the local socket alive for that wait.
  if (
    request.method === 'terminal.send' &&
    typeof request.params === 'object' &&
    request.params !== null &&
    (request.params as { agentPrompt?: unknown }).agentPrompt === true
  ) {
    return 'wait'
  }
  // Resume (and assign to a past conversation) waits for the reopened agent to report its
  // conversation; a when-idle prompt with `wait` holds until its target is free or its window ends.
  const reuse =
    typeof request.params === 'object' && request.params !== null
      ? (request.params as { wait?: unknown; ref?: unknown })
      : {}
  if (
    request.method === 'sessionManage.resume' ||
    (request.method === 'sessionManage.assign' && typeof reuse.ref === 'string')
  ) {
    return 'wait'
  }
  if (request.method === 'sessionManage.continueWhenIdle' && reuse.wait === true) {
    return 'ask'
  }
  // Transfers and moves also wait on agents and hosts; keepalive and disconnect cancellation cover
  // every step.
  // Why: orchestration.ask blocks unconditionally (default 600 s) holding the
  // RPC open until a reply lands or the deadline passes, so it needs the same
  // keepalive as check --wait or the 30 s socket idle timer tears it down. It
  // also relies on the abort signal (only wired for long-polls) to release the
  // waiter when the asking client disconnects.
  if (
    request.method === 'orchestration.ask' ||
    request.method === 'sessionManage.ask' ||
    request.method === 'sessionManage.handoff' ||
    request.method === 'sessionManage.consolidate' ||
    request.method === 'sessionManage.relocate'
  ) {
    return 'ask'
  }
  // A restart may wait out a hung turn; conflicts reads git on every live worktree's host; tidy
  // observes every sidebar conversation; find-owner does too, then searches and asks JEV.
  if (
    request.method === 'sessionManage.restart' ||
    request.method === 'sessionManage.conflicts' ||
    request.method === 'sessionManage.tidy' ||
    request.method === 'sessionManage.findOwner'
  ) {
    return 'wait'
  }
  if (request.method === 'orchestration.check') {
    const params = request.params as { wait?: unknown } | undefined
    return params?.wait === true ? 'wait' : null
  }
  return null
}
