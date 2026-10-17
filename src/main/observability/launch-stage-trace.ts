// Launch-stage spans for a terminal/agent session launch.
//
// Why this exists: attaching a new agent session measured p50 1.24s / p95 33.5s
// (2026-09-15, 105 session-created→session-attached pairs in daemon.log), and the
// trace file carried only `git.exec`, breadcrumbs and `skill.recovery` — so no
// reader could tell WHICH launch stage was slow. This module emits one span per
// stage into the same NDJSON trace file, in a fixed order:
//
//   launch.process_spawn → launch.shell_ready → launch.startup_command
//   → launch.agent_hook_status
//
// Each span's duration is the boundary-to-boundary time of that stage;
// `launch.elapsed_ms` is the cumulative time since the launch began, so a
// reader can rank stages without joining spans.
//
// Privacy (load-bearing): every attribute value written here is either a
// number or a token matched against `SAFE_TOKEN`. Prompt text, credentials,
// environment values and terminal output cannot reach a span even if a caller
// passes them — an unmatched token is replaced with `invalid`. This is a
// stronger guarantee than the sink-time redactor and is asserted by tests.
//
// Launch cause (latency telemetry, `latencyTelemetry` setting): the process_spawn
// span also carries `launch.trigger` (a fixed token, default `unknown`),
// `launch.visible` when the caller knows it, and `launch.worktree` — a short
// one-way hash, never the worktree id or path. With the setting off none of the
// three is written.
//
// Side-effect freedom (load-bearing): automatic session chains and
// build+review workers read hook status / `terminal.wait {for:'tui-idle'}`.
// Recording a stage must never change those signals, so every exported
// function swallows its own errors and never throws into the launch path.
// Spans are no-ops when no tracer sink is installed (see tracer.ts).

import { createHash } from 'node:crypto'
import { normalizeLaunchTrigger, type LaunchTrigger } from '../../shared/launch-trigger'
import { isLatencyTelemetryEnabled } from './latency-probe-switch'
import { startSpan, type ActiveSpan } from './tracer'

/** Fixed stage order. A stage that never reports is skipped silently, and its
 *  span is discarded rather than written as a zero-signal record. */
export const LAUNCH_STAGES = [
  'process_spawn',
  'shell_ready',
  'startup_command',
  'agent_hook_status'
] as const

export type LaunchStage = (typeof LAUNCH_STAGES)[number]

export type LaunchStageDetail = {
  /** Short enum-ish outcome token, e.g. `ready_marker` / `timeout_expired`. */
  readonly outcome?: string
  /** Elapsed measured by the process that owns the stage (the daemon), when it
   *  differs from main's own boundary timing. */
  readonly reportedElapsedMs?: number
  /** Number of pre-ready stdin writes flushed at the startup-command boundary. */
  readonly queuedWrites?: number
}

export type BeginLaunchStageTraceArgs = {
  /** Session/PTY identity the stage reports arrive under. */
  readonly launchId: string
  /** Stable pane identity, when the launch has one. */
  readonly paneKey?: string | undefined
  /** Agent name as launched (`claude` / `codex` / …). */
  readonly agent?: string | undefined
  /** What caused this launch (latency telemetry). Recorded on `launch.process_spawn`
   *  only; any value outside the fixed token set is written as `unknown`. */
  readonly trigger?: LaunchTrigger | undefined
  /** Whether the pane was on screen when the launch began, when the caller knows. */
  readonly visible?: boolean | undefined
  /** Worktree identity. Written only as a short one-way hash: ids can embed a path. */
  readonly worktreeId?: string | undefined
}

// Why bounded: a launch whose last stage never reports would otherwise pin its
// entry (and one open span) forever. 64 concurrent launches is far past any
// real window; the oldest entry is evicted rather than grown.
const MAX_TRACKED_LAUNCHES = 64
const SAFE_TOKEN = /^[a-z0-9][\w.:@|/-]{0,127}$/i
const INVALID_TOKEN = 'invalid'
// 12 hex chars (48 bits) tells a reader which launches share a worktree without
// being reversible to the path a worktree id can embed.
const WORKTREE_HASH_CHARS = 12

/** Launch-cause attributes, written on the process_spawn span only. */
type LaunchAttribution = {
  readonly trigger: LaunchTrigger
  readonly visible: boolean | undefined
  readonly worktreeHash: string | undefined
}

type OpenStage = {
  readonly stage: LaunchStage
  readonly span: ActiveSpan
  /** Flipped to false to discard a stage that never reported. */
  keep: boolean
}

type LaunchTrace = {
  readonly launchId: string
  readonly paneKey: string | undefined
  readonly agent: string | undefined
  /** Null when latency telemetry is off: the span then carries exactly what it did before. */
  readonly attribution: LaunchAttribution | null
  readonly startedAtMs: number
  stageStartedAtMs: number
  index: number
  open: OpenStage | null
}

const traces = new Map<string, LaunchTrace>()
const launchIdByPaneKey = new Map<string, string>()

function safeToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  return SAFE_TOKEN.test(value) ? value : INVALID_TOKEN
}

/** Short one-way hash of a worktree id; never the id itself (it can embed a path). */
export function hashLaunchWorktreeId(worktreeId: string | undefined): string | undefined {
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    return undefined
  }
  return createHash('sha256').update(worktreeId).digest('hex').slice(0, WORKTREE_HASH_CHARS)
}

function resolveLaunchAttribution(args: BeginLaunchStageTraceArgs): LaunchAttribution | null {
  if (!isLatencyTelemetryEnabled()) {
    return null
  }
  const trigger = normalizeLaunchTrigger(args.trigger)
  return {
    // Why normalize and then safe-token: the enum is the contract, and the shared
    // safe-token check stays the last gate before anything reaches a span.
    trigger: safeToken(trigger) === trigger ? trigger : 'unknown',
    visible: typeof args.visible === 'boolean' ? args.visible : undefined,
    worktreeHash: hashLaunchWorktreeId(args.worktreeId)
  }
}

function safeDurationMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.round(value)
}

function openStageSpan(trace: LaunchTrace, index: number): void {
  const stage = LAUNCH_STAGES[index]
  if (!stage) {
    trace.open = null
    trace.index = index
    return
  }
  const open: OpenStage = {
    stage,
    span: startSpan(`launch.${stage}`, {
      attributes: { kind: 'launch' },
      shouldRecord: () => open.keep
    }),
    keep: true
  }
  open.span.setAttribute('launch.stage', stage)
  open.span.setAttribute('launch.id', trace.launchId)
  if (trace.paneKey) {
    open.span.setAttribute('launch.pane', trace.paneKey)
  }
  if (trace.agent) {
    open.span.setAttribute('launch.agent', trace.agent)
  }
  if (stage === 'process_spawn' && trace.attribution) {
    open.span.setAttribute('launch.trigger', trace.attribution.trigger)
    if (trace.attribution.visible !== undefined) {
      open.span.setAttribute('launch.visible', trace.attribution.visible)
    }
    if (trace.attribution.worktreeHash) {
      open.span.setAttribute('launch.worktree', trace.attribution.worktreeHash)
    }
  }
  trace.open = open
  trace.index = index
  trace.stageStartedAtMs = Date.now()
}

function discardTrace(trace: LaunchTrace): void {
  if (trace.open) {
    trace.open.keep = false
    trace.open.span.end()
    trace.open = null
  }
  traces.delete(trace.launchId)
  if (trace.paneKey && launchIdByPaneKey.get(trace.paneKey) === trace.launchId) {
    launchIdByPaneKey.delete(trace.paneKey)
  }
}

function evictOldestIfFull(): void {
  while (traces.size >= MAX_TRACKED_LAUNCHES) {
    const oldest = traces.values().next().value
    if (!oldest) {
      return
    }
    discardTrace(oldest)
  }
}

/** Open a launch trace and start its first stage span. Safe to call for a
 *  launch that is later abandoned — `endLaunchStageTrace` or eviction cleans up. */
export function beginLaunchStageTrace(args: BeginLaunchStageTraceArgs): void {
  try {
    const launchId = safeToken(args.launchId)
    if (!launchId || launchId === INVALID_TOKEN) {
      return
    }
    const existing = traces.get(launchId)
    if (existing) {
      discardTrace(existing)
    }
    evictOldestIfFull()
    const paneKey = safeToken(args.paneKey)
    const trace: LaunchTrace = {
      launchId,
      paneKey,
      agent: safeToken(args.agent),
      attribution: resolveLaunchAttribution(args),
      startedAtMs: Date.now(),
      stageStartedAtMs: Date.now(),
      index: 0,
      open: null
    }
    traces.set(launchId, trace)
    if (paneKey) {
      launchIdByPaneKey.set(paneKey, launchId)
    }
    openStageSpan(trace, 0)
  } catch {
    // Why swallow: diagnostics must never fail a launch (see header).
  }
}

function completeStage(trace: LaunchTrace, stage: LaunchStage, detail?: LaunchStageDetail): void {
  const target = LAUNCH_STAGES.indexOf(stage)
  if (target === -1 || trace.index > target) {
    return
  }
  // Stages that never reported are discarded, but their boundary still belongs
  // to the stage that did report — so the reported span covers the real gap.
  while (trace.index < target && trace.open) {
    trace.open.keep = false
    trace.open.span.end()
    openStageSpan(trace, trace.index + 1)
  }
  const open = trace.open
  if (!open || open.stage !== stage) {
    return
  }
  open.span.setAttribute('launch.elapsed_ms', Math.max(0, Date.now() - trace.startedAtMs))
  open.span.setAttribute('launch.stage_ms', Math.max(0, Date.now() - trace.stageStartedAtMs))
  const outcome = safeToken(detail?.outcome)
  if (outcome) {
    open.span.setAttribute('launch.outcome', outcome)
  }
  const reportedElapsedMs = safeDurationMs(detail?.reportedElapsedMs)
  if (reportedElapsedMs !== undefined) {
    open.span.setAttribute('launch.reported_elapsed_ms', reportedElapsedMs)
  }
  const queuedWrites = safeDurationMs(detail?.queuedWrites)
  if (queuedWrites !== undefined) {
    open.span.setAttribute('launch.queued_writes', queuedWrites)
  }
  open.span.end()
  trace.open = null
  if (target === LAUNCH_STAGES.length - 1) {
    discardTrace(trace)
    return
  }
  openStageSpan(trace, target + 1)
}

/** Record that `stage` finished for the launch tracked under `launchId`. */
export function completeLaunchStage(
  launchId: string,
  stage: LaunchStage,
  detail?: LaunchStageDetail
): void {
  try {
    const trace = traces.get(launchId)
    if (trace) {
      completeStage(trace, stage, detail)
    }
  } catch {
    // See header: never throw into the launch path.
  }
}

/** Record a stage for the launch that owns `paneKey`. Agent hook status is
 *  pane-keyed, and its arrival is the only launch signal main sees directly. */
export function completeLaunchStageForPane(
  paneKey: string,
  stage: LaunchStage,
  detail?: LaunchStageDetail
): void {
  try {
    const launchId = launchIdByPaneKey.get(paneKey)
    if (launchId) {
      completeLaunchStage(launchId, stage, detail)
    }
  } catch {
    // See header: never throw into the launch path.
  }
}

/** Drop a launch trace (process exit, failed spawn). Any open stage span is
 *  discarded rather than recorded as a stage that "took" the whole session. */
export function endLaunchStageTrace(launchId: string): void {
  try {
    const trace = traces.get(launchId)
    if (trace) {
      discardTrace(trace)
    }
  } catch {
    // See header: never throw into the launch path.
  }
}

export function _resetLaunchStageTracesForTests(): void {
  // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: discardTrace deletes from the map being iterated
  for (const trace of [...traces.values()]) {
    discardTrace(trace)
  }
  traces.clear()
  launchIdByPaneKey.clear()
}

export function _trackedLaunchStageTraceCountForTests(): number {
  return traces.size
}
