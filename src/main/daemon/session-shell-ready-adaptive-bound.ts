// Adaptive extension policy for the Codex shell-ready bound.
//
// Why: Codex's shell-ready bound is a fixed 300 ms (CODEX_SHELL_READY_TIMEOUT_MS)
// against 15 s for every other agent, and on a loaded Mac zsh startup regularly
// exceeds 300 ms — 10 of 11 `shell-ready-timeout` events measured on 2026-09-15
// fired at `timeoutMs: 300`. On timeout the barrier flushes its pre-ready stdin
// queue into a shell that may still be sourcing its profile, which is how a
// startup command gets eaten.
//
// The policy: keep 300 ms as the floor (no launch waits less than today), and
// while nothing yet proves the shell is alive, re-arm in floor-sized steps up to
// a 3 s cap. Two things count as proof, and either ends the extension:
//
//   1. The prompt-readiness probe identified the shell PID (the shell emitted
//      its startup identity marker).
//   2. The shell produced output at all — an interactive shell prints its prompt
//      as soon as it is done sourcing its profile.
//
// Why (2) is here even though the brief named only (1): the plain-Codex launch
// path deliberately enables NEITHER the `ready` nor the `identity` wrapper
// feature (selectShellStartupFeatures), so its barrier can never see an identity
// marker and (1) alone would turn today's 300 ms settle into a flat 3 s wait on
// every such launch. Gating on "no bytes from the shell yet" keeps the fast case
// byte-for-byte on today's timing and spends the extension only on the case the
// measurement actually describes: a shell that has produced nothing by 300 ms
// because it is still sourcing its profile.
//
// Non-Codex bounds never opt in: the barrier only consults this policy when a
// cap was supplied for the launch.

// Why: Codex skips marker-gated command delivery; this only bounds older
// daemon/local paths that still report shell-ready for Codex. Kept here, with
// the cap, so the floor and its extension policy have one home; the barrier
// re-exports it under its historical name.
export const CODEX_SHELL_READY_TIMEOUT_MS = 300
export const CODEX_SHELL_READY_ADAPTIVE_CAP_MS = 3_000

/** The cap a received shell-ready bound opts into, or undefined for today's
 *  fixed behaviour. The wire still carries only the floor, so a new daemon
 *  extends adaptively even for an older main that knows nothing about the cap. */
export function resolveShellReadyAdaptiveCapMs(
  shellReadyTimeoutMs: number | undefined
): number | undefined {
  return shellReadyTimeoutMs === CODEX_SHELL_READY_TIMEOUT_MS
    ? CODEX_SHELL_READY_ADAPTIVE_CAP_MS
    : undefined
}

export type AdaptiveShellReadyDecision =
  /** Re-arm the ready timer for `waitMs` more; total wait stays ≤ cap. */
  | { readonly action: 'extend'; readonly waitMs: number; readonly elapsedMs: number }
  /** Time the launch out exactly as it does today (release + flush). */
  | { readonly action: 'expire'; readonly elapsedMs: number }

export type AdaptiveShellReadyInput = {
  /** The configured bound for this launch — the floor, and the extension step. */
  readonly baseTimeoutMs: number
  /** Milliseconds since the barrier armed, including every prior extension. */
  readonly elapsedMs: number
  /** Upper bound on total wait. Absent/not greater than the floor ⇒ no adaptivity. */
  readonly capMs?: number | undefined
  /** True once the readiness probe has the shell PID (startup identity seen). */
  readonly probeIdentifiedShell: boolean
  /** True once the shell has produced any output — it is past its profile. */
  readonly shellOutputObserved: boolean
}

/** Pure decision: extend the shell-ready wait, or let it expire. */
export function decideAdaptiveShellReadyWait(
  input: AdaptiveShellReadyInput
): AdaptiveShellReadyDecision {
  const elapsedMs = Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0
  const capMs = input.capMs
  if (capMs === undefined || !Number.isFinite(capMs)) {
    return { action: 'expire', elapsedMs }
  }
  const floorMs = Number.isFinite(input.baseTimeoutMs) ? Math.max(1, input.baseTimeoutMs) : 1
  // Never shorter than the floor, and never adaptive when the cap does not
  // actually extend it.
  if (capMs <= floorMs) {
    return { action: 'expire', elapsedMs }
  }
  // The shell announced itself (identity marker) or has started talking at all:
  // keep today's timing rather than holding stdin longer than the bound.
  if (input.probeIdentifiedShell || input.shellOutputObserved) {
    return { action: 'expire', elapsedMs }
  }
  const remainingMs = capMs - elapsedMs
  if (remainingMs <= 0) {
    return { action: 'expire', elapsedMs }
  }
  return { action: 'extend', waitMs: Math.min(floorMs, remainingMs), elapsedMs }
}
