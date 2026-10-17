import { useAppStore } from '@/store'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import {
  confirmAgentHibernationCandidates,
  type AgentHibernationConfirmationState
} from './agent-hibernation-confirmation'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  isAgentSleepPolicyCurrent,
  resolveAgentSleepPolicy,
  type AgentSleepPolicy
} from './agent-sleep-policy'
import {
  checkAgentSleepGuards,
  readAgentSleepVerdicts,
  type AgentSleepGuardVerdict
} from './agent-sleep-guards'
import {
  recordAgentSleep,
  recordAgentSleepSummary,
  resetAgentSleepAuditForTests
} from './agent-sleep-audit'
import {
  noteAgentSleepKeep,
  takeCachedAgentSleepVerdict,
  type KeptCounts
} from './agent-sleep-keeps'
import { startAgentSleepWakeTracker, stopAgentSleepWakeTracker } from './agent-sleep-wake-tracker'
import {
  noteReviewSessionAsleep,
  refreshReviewSleepTargets,
  reviewSleepTargetFor
} from './review-sleep-targets'
import { startLegacySleepRecordNormalization } from './agent-sleep-legacy-records'
import { startPersonAttachTracking } from './idle-auto-close/idle-keep-guards'
import { startAgentPaneHistory } from './idle-auto-close/agent-pane-history'
import {
  countOnScreenDoneAgents,
  currentCandidates,
  persistHibernationPaneTouchesNow
} from './agent-hibernation-plan-now'
import {
  cacheAgentSleepVerdict,
  clearAgentSleepVerdicts,
  pruneAgentSleepVerdicts
} from './agent-sleep-verdict-cache'

export const AGENT_HIBERNATION_TICK_MS = 60 * 1000
/** Longest one pane's shutdown may hold the tick; a hung kill must not stop sleep for the session. */
export const AGENT_HIBERNATION_SHUTDOWN_TIMEOUT_MS = 30 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type AgentHibernationCoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

type AgentHibernationCoordinatorState = {
  interval: IntervalHandle | null
  confirmationState: AgentHibernationConfirmationState
  tickInFlight: boolean
  shuttingDownCandidateIds: Set<string>
  now: () => number
  stopTracking: (() => void) | null
  /** Bumped by every stop; a drain started under an older generation acts on nothing more. */
  generation: number
}

const coordinator: AgentHibernationCoordinatorState = {
  interval: null,
  confirmationState: {},
  tickInFlight: false,
  shuttingDownCandidateIds: new Set(),
  now: () => Date.now(),
  stopTracking: null,
  generation: 0
}

/**
 * The kill switch, read again before every single act: the coordinator was not stopped since this
 * drain began, and the settings still resolve to the policy it began under. Why: a backlog drain
 * takes minutes, and switching agent sleep off mid-drain kept sleeping the rest (G4).
 */
function mayStillAct(policy: AgentSleepPolicy, generation: number): boolean {
  return (
    generation === coordinator.generation &&
    isAgentSleepPolicyCurrent(policy, useAppStore.getState().settings)
  )
}

/**
 * The act, for one pane the tick's shared reading would act on: re-plan its worktree and re-read
 * G1-G3 and its process for that pane alone, immediately before the shutdown or the drop (G4).
 */
async function actOnPaneIfStillEligible(
  confirmedCandidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  generation: number,
  kept: KeptCounts
): Promise<void> {
  const { id, worktreeId } = confirmedCandidate
  if (coordinator.shuttingDownCandidateIds.has(id) || !mayStillAct(policy, generation)) {
    return
  }
  const now = coordinator.now()
  // Why: the confirmed pane can only be authorized by its owning worktree. A
  // global sweep here made C pane teardowns issue C×W fresh runtime listings.
  const candidates = await currentCandidates(now, policy, worktreeId)
  const stillEligible = candidates.some(
    (candidate) =>
      candidate.id === confirmedCandidate.id && candidate.signature === confirmedCandidate.signature
  )
  if (!stillEligible) {
    return
  }
  const verdict = await checkAgentSleepGuards(confirmedCandidate, now)
  if (!mayStillAct(policy, generation)) {
    return
  }
  if (verdict.keep) {
    noteAgentSleepKeep(confirmedCandidate, { ...verdict, keep: verdict.keep }, policy, now, kept)
    return
  }
  coordinator.shuttingDownCandidateIds.add(id)
  try {
    const state = useAppStore.getState()
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    await state.shutdownCompletedAgentPaneForHibernation(worktreeId, {
      paneKey: confirmedCandidate.paneKey,
      tabId: confirmedCandidate.tabId,
      leafId: confirmedCandidate.leafId,
      ptyId: confirmedCandidate.targetPtyIds[0],
      ...(runtimeEnvironmentId
        ? { expectedRuntimePtyId: confirmedCandidate.expectedRuntimePtyIds[0] }
        : {}),
      launchOptions: reviewSleepTargetFor(confirmedCandidate.paneKey, worktreeId)?.launchOptions
    })
    recordAgentSleep(confirmedCandidate, policy, 'done', now, verdict.evidence)
    if (reviewSleepTargetFor(confirmedCandidate.paneKey, worktreeId)) {
      void noteReviewSessionAsleep({ paneKey: confirmedCandidate.paneKey, worktreeId })
    }
  } catch (err) {
    console.warn('[agent-hibernation] failed to hibernate agent pane:', id, err)
    recordAgentSleep(confirmedCandidate, policy, 'failed', now, {
      ...verdict.evidence,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    coordinator.shuttingDownCandidateIds.delete(id)
  }
}

/** One confirmed pane with this tick's verdict: shadow logs it; On keeps it or acts after G4. */
async function settleCandidate(
  candidate: AgentHibernationCandidate,
  verdict: AgentSleepGuardVerdict,
  policy: AgentSleepPolicy,
  generation: number,
  now: number,
  kept: KeptCounts
): Promise<void> {
  if (!policy.act || (verdict.keep && verdict.keep !== 'shell-foreground')) {
    if (verdict.keep) {
      noteAgentSleepKeep(candidate, { ...verdict, keep: verdict.keep }, policy, now, kept)
    } else {
      recordAgentSleep(candidate, policy, 'would', now, verdict.evidence)
      cacheAgentSleepVerdict(candidate, policy, now, null)
    }
    return
  }
  await actOnPaneIfStillEligible(candidate, policy, generation, kept)
}

// Why: `tickInFlight` guards every tick, so one shutdown that never settles (an unanswered kill
// IPC) silently ended agent sleep until relaunch. The shutdown keeps running; the pane stays
// claimed in `shuttingDownCandidateIds` until it settles.
async function settleWithin(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function runAgentHibernationTick(): Promise<void> {
  if (coordinator.tickInFlight) {
    return
  }
  coordinator.tickInFlight = true
  try {
    const policy = resolveAgentSleepPolicy(useAppStore.getState().settings)
    if (!policy) {
      coordinator.confirmationState = {}
      return
    }
    const generation = coordinator.generation
    // Why each tick: a review publish arms a pane, and its decision disarms it, between ticks.
    await refreshReviewSleepTargets()
    const now = coordinator.now()
    const plan = confirmAgentHibernationCandidates(
      coordinator.confirmationState,
      await currentCandidates(now, policy)
    )
    coordinator.confirmationState = plan.confirmationState
    pruneAgentSleepVerdicts(new Set(Object.keys(plan.confirmationState)))
    const kept: KeptCounts = {}
    const onScreen = countOnScreenDoneAgents(useAppStore.getState())
    if (onScreen > 0) {
      kept.visible = onScreen
    }
    const pending = plan.candidates.filter(
      (candidate) =>
        !coordinator.shuttingDownCandidateIds.has(candidate.id) &&
        !takeCachedAgentSleepVerdict(candidate, policy, now, kept)
    )
    // Why one reading for the whole confirmed set: shadow is on for everyone by default, and a
    // re-plan, a main call (which lists every sidebar row) and a process read per pane, repeated
    // for 40 idle agents every few minutes, was new main-process work for nothing.
    const verdicts =
      pending.length > 0
        ? await readAgentSleepVerdicts(pending, now)
        : new Map<string, AgentSleepGuardVerdict>()
    // Why: drain sequentially. Each shutdown re-runs a full runtime-liveness sweep and
    // then a stopExact RPC, so firing the whole confirmed set at once meant ~100
    // concurrent sweeps plus ~100 concurrent stops on the first pass after a backlog.
    // Awaiting also makes `tickInFlight` cover the drain, and each act re-validates against
    // a fresh plan at its own turn, so a slow drain cannot act on stale confirmation.
    for (const candidate of pending) {
      const verdict = verdicts.get(candidate.id)
      if (!mayStillAct(policy, generation)) {
        return
      }
      if (verdict) {
        await settleWithin(
          settleCandidate(candidate, verdict, policy, generation, now, kept),
          AGENT_HIBERNATION_SHUTDOWN_TIMEOUT_MS
        )
      }
    }
    if (mayStillAct(policy, generation)) {
      recordAgentSleepSummary(policy, plan.candidates.length, kept, now)
    }
  } finally {
    coordinator.tickInFlight = false
  }
}

/** Why: the tick saves touch stamps once a minute; a restart must not lose the last minute's. */
function flushTouchesWhenWindowCloses(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {}
  }
  const flush = (): void => persistHibernationPaneTouchesNow()
  window.addEventListener('pagehide', flush)
  return () => window.removeEventListener('pagehide', flush)
}

export function startAgentHibernationCoordinator(
  options: AgentHibernationCoordinatorOptions = {}
): () => void {
  if (coordinator.interval !== null) {
    return stopAgentHibernationCoordinator
  }
  coordinator.now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? AGENT_HIBERNATION_TICK_MS
  const stopWakeTracker = startAgentSleepWakeTracker(coordinator.now)
  const stopAttachTracking = startPersonAttachTracking(coordinator.now)
  const stopAgentPaneHistory = startAgentPaneHistory()
  const stopTouchFlush = flushTouchesWhenWindowCloses()
  const stopLegacyNormalization = startLegacySleepRecordNormalization()
  coordinator.stopTracking = () => {
    stopWakeTracker()
    stopAttachTracking()
    stopAgentPaneHistory()
    stopTouchFlush()
    stopLegacyNormalization()
  }
  coordinator.interval = setInterval(() => void runAgentHibernationTick(), intervalMs)
  return stopAgentHibernationCoordinator
}

export function stopAgentHibernationCoordinator(): void {
  coordinator.generation += 1
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.stopTracking?.()
  coordinator.stopTracking = null
  coordinator.confirmationState = {}
  clearAgentSleepVerdicts()
}

export function isAgentHibernationTickInFlightForTests(): boolean {
  return coordinator.tickInFlight
}

export function resetAgentHibernationCoordinatorForTests(): void {
  stopAgentHibernationCoordinator()
  stopAgentSleepWakeTracker()
  coordinator.shuttingDownCandidateIds.clear()
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
  resetAgentSleepAuditForTests()
}
