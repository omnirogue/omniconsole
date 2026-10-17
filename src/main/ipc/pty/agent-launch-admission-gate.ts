import type { GlobalSettings } from '../../../shared/global-settings-types'
import { recognizeAgentProcessFromCommandLine } from '../../../shared/agent-process-recognition'
import {
  AGENT_LAUNCH_CANCELLED_ERROR,
  agentLaunchAdmission,
  normalizeLaunchAdmissionKey,
  resolveLaunchAdmissionPer10s,
  type AgentLaunchAdmission,
  type AgentLaunchPriority
} from '../../pty/agent-launch-admission'
import { noteRestoreSweepAgentStart } from '../../pty/restore-sweep-activity'

export { AGENT_LAUNCH_CANCELLED_ERROR }

// Why: a start can wait in the admission queue for minutes, so the pane that asked for it can be
// closed, archived or remounted meanwhile. Its transport sends pty:cancelAgentLaunch with the
// one-off token it spawned with; the queued start then leaves without using a slot. A cancel can
// beat its own spawn to this point (the spawn is still in preflight), so it is remembered for a
// while; tokens are unique per start, so a stale entry never cancels anything else.
const CANCELLED_TOKEN_TTL_MS = 10 * 60_000
const MAX_CANCELLED_TOKENS = 1024
const cancelledLaunchTokens = new Map<string, number>()
const queuedLaunchTokens = new Set<string>()

function pruneCancelledLaunchTokens(now: number): void {
  for (const [token, at] of cancelledLaunchTokens) {
    if (now - at > CANCELLED_TOKEN_TTL_MS || cancelledLaunchTokens.size > MAX_CANCELLED_TOKENS) {
      cancelledLaunchTokens.delete(token)
    }
  }
}

export type PtySpawnAgentLaunchGateArgs = {
  /** The command the provider will run in the new process, after all main-side rewrites. */
  launchCommand: string | undefined
  launchAgent?: unknown
  resumeProviderSession?: unknown
  interruptedRestore?: boolean
  /** 'person' or 'explicit' (literals only); anything else waits in the background lane. */
  launchPriority?: unknown
  /** The renderer pane the start is for; lets a later reveal promote it while it waits. */
  launchAdmissionKey?: unknown
  /** One-off id of this start, so the pane's transport can cancel it while it is queued. */
  launchAdmissionToken?: unknown
  /** The spawn reattaches a PTY that is still running, so its command is never run. */
  liveReattach: boolean
  /** Read at every drain so a changed limit applies to starts already queued. Both production
   *  spawn paths wire it; a harness without a settings source is not capped. */
  getSettings?: () =>
    | Pick<GlobalSettings, 'launchAdmissionPer10s' | 'restoreFloodGuard'>
    | null
    | undefined
  isCancelled?: () => boolean
  /** The caller's connection; its abort drops the queued start at once (no slot used). */
  signal?: AbortSignal
  /** Called once when the start has to wait for a slot (the RPC keeps its socket alive). */
  onQueued?: () => void
  admission?: AgentLaunchAdmission
}

/** The app-wide cap in force: restoreFloodGuard false is the kill switch for the whole restore
 *  flood fix, the admission window included, so it means no cap (the earlier behavior). */
export function resolveAgentLaunchLimit(
  settings: Pick<GlobalSettings, 'launchAdmissionPer10s' | 'restoreFloodGuard'> | null | undefined
): number {
  return settings?.restoreFloodGuard === false ? 0 : resolveLaunchAdmissionPer10s(settings)
}

function resolveAgentLaunchLane(value: unknown): AgentLaunchPriority {
  return value === 'person' || value === 'explicit' ? value : 'background'
}

/** True when a spawn names an existing session its provider still runs: the provider
 *  reattaches it and never runs the carried command. */
export function isLivePtyReattach(
  provider: { hasPty?: (id: string) => boolean },
  isMintedSessionId: boolean,
  sessionAppId: string | undefined
): boolean {
  if (isMintedSessionId || sessionAppId === undefined) {
    return false
  }
  try {
    return provider.hasPty?.(sessionAppId) === true
  } catch {
    return false
  }
}

/** A spawn that will start an agent process: carries a command main will run, and either
 *  declares agent launch metadata or runs a recognizable agent CLI. Plain shells and
 *  live reattaches never count. */
export function isPtySpawnAgentLaunch(args: PtySpawnAgentLaunchGateArgs): boolean {
  if (args.liveReattach || typeof args.launchCommand !== 'string') {
    return false
  }
  if (args.launchCommand.trim().length === 0) {
    return false
  }
  return Boolean(
    args.launchAgent ||
    args.resumeProviderSession ||
    args.interruptedRestore ||
    recognizeAgentProcessFromCommandLine(args.launchCommand, { includeHeadlessOneShot: true })
  )
}

/**
 * Waits for an app-wide agent start slot (Sal, 2026-09-30: at most 3 per 10 seconds). Called at
 * the top of both main spawn pipelines, before the per-worktree spawn mutex, so a queued agent
 * never holds up plain shells. Throws when the caller cancelled while queued.
 */
export async function gatePtySpawnAgentLaunch(args: PtySpawnAgentLaunchGateArgs): Promise<void> {
  if (!args.getSettings || !isPtySpawnAgentLaunch(args)) {
    return
  }
  if (
    resolveAgentLaunchLane(args.launchPriority) === 'background' &&
    (args.resumeProviderSession || args.interruptedRestore)
  ) {
    // Why before the guard check: summaries hold off after a sweep whether or not it is capped.
    noteRestoreSweepAgentStart()
  }
  // Why: with the guard switched off nothing queues or takes a slot, so starts already admitted
  // never delay a later one; starts queued before the switch drain at the next window edge
  // (getLimit below reads 0).
  if (args.getSettings()?.restoreFloodGuard === false) {
    return
  }
  const admission = args.admission ?? agentLaunchAdmission
  const key = normalizeLaunchAdmissionKey(args.launchAdmissionKey)
  const token = normalizeLaunchAdmissionKey(args.launchAdmissionToken)
  const isCancelled = (): boolean =>
    args.isCancelled?.() === true || (token !== undefined && cancelledLaunchTokens.has(token))
  if (isCancelled()) {
    if (token) {
      cancelledLaunchTokens.delete(token)
    }
    throw new Error(AGENT_LAUNCH_CANCELLED_ERROR)
  }
  if (token) {
    queuedLaunchTokens.add(token)
  }
  // Why: without this a start whose caller disconnected would sit in the backlog until the next
  // drain (up to a whole window) before leaving; the abort now rechecks the queue at once.
  const onAbort = (): void => admission.recheck()
  args.signal?.addEventListener('abort', onAbort, { once: true })
  let admitted: boolean
  try {
    admitted = await admission.admit({
      priority: resolveAgentLaunchLane(args.launchPriority),
      getLimit: () => resolveAgentLaunchLimit(args.getSettings?.()),
      ...(key ? { key } : {}),
      ...(args.onQueued ? { onQueued: args.onQueued } : {}),
      isCancelled
    })
  } finally {
    args.signal?.removeEventListener('abort', onAbort)
    if (token) {
      queuedLaunchTokens.delete(token)
      cancelledLaunchTokens.delete(token)
    }
  }
  if (!admitted) {
    throw new Error(AGENT_LAUNCH_CANCELLED_ERROR)
  }
}

/**
 * The pane that asked for this start went away (tab closed, workspace unmounted, pane remounted):
 * a start still queued leaves at once without using a slot. True when it was still queued.
 */
export function cancelPtySpawnAgentLaunch(
  token: unknown,
  admission: AgentLaunchAdmission = agentLaunchAdmission,
  now = Date.now()
): boolean {
  const normalized = normalizeLaunchAdmissionKey(token)
  if (!normalized) {
    return false
  }
  pruneCancelledLaunchTokens(now)
  cancelledLaunchTokens.set(normalized, now)
  const wasQueued = queuedLaunchTokens.has(normalized)
  admission.recheck()
  return wasQueued
}

export function resetAgentLaunchCancellationsForTests(): void {
  cancelledLaunchTokens.clear()
  queuedLaunchTokens.clear()
}

/** A person revealed the pane whose agent start is queued: it moves into the person lane. */
export function promotePtySpawnAgentLaunch(
  key: unknown,
  admission: AgentLaunchAdmission = agentLaunchAdmission
): boolean {
  const normalized = normalizeLaunchAdmissionKey(key)
  return normalized ? admission.promote(normalized) : false
}
