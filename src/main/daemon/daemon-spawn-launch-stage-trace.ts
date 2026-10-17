// Launch-stage tracing for the main-side daemon spawn: main owns the
// `process_spawn` stage (request → session created/attached, the window the
// 2026-09-15 measurement showed at p50 1.24s / p95 33.5s). The daemon reports
// shell-ready and startup-command delivery over its own relay.

import {
  beginLaunchStageTrace,
  completeLaunchStage,
  endLaunchStageTrace,
  type BeginLaunchStageTraceArgs
} from '../observability/launch-stage-trace'
import type { PtySpawnOptions } from '../providers/types'

/** Why gated on a startup command: the launch stages describe an agent launch. A
 *  plain shell tab has no startup command, readiness barrier or hook status, so a
 *  trace for it could only ever record its spawn. */
export function tracesLaunchStages(opts: PtySpawnOptions): boolean {
  return Boolean(opts.command) && opts.attachOnly !== true
}

/** Launch-stage identity for a spawn, shared by the daemon and local-provider paths so
 *  both record the same launch cause (trigger, visibility, hashed worktree). */
export function launchStageTraceArgsFor(
  launchId: string,
  opts: PtySpawnOptions
): BeginLaunchStageTraceArgs {
  return {
    launchId,
    paneKey: opts.paneKey,
    agent: opts.launchAgent,
    trigger: opts.launchTrigger,
    visible: opts.launchVisible,
    worktreeId: opts.worktreeId
  }
}

export function beginDaemonLaunchStageTrace(sessionId: string, opts: PtySpawnOptions): void {
  beginLaunchStageTrace(launchStageTraceArgsFor(sessionId, opts))
}

export function completeDaemonSpawnLaunchStage(sessionId: string): void {
  completeLaunchStage(sessionId, 'process_spawn', { outcome: 'spawned' })
}

export function abandonDaemonLaunchStageTrace(sessionId: string): void {
  endLaunchStageTrace(sessionId)
}
