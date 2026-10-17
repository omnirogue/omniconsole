/**
 * The idle rules R2 (idle shell-only workspaces, slept keeping their history) and R3 (hidden
 * browser pages), ticking once a minute in the window; R1 (agent sleep) runs on the agent hibernation coordinator. Every tick reads the store,
 * the local daemon's sessions and the local runtime's terminals, asks the pure rules what is idle,
 * and once two ticks agree re-reads G1-G3 for that one target (G4) and then either writes what it
 * would do (`shadow`, or `on` while the restore flood guard is off) or does it and writes the
 * outcome (`on`). Every line is actor `hibernation` in session-actions.jsonl.
 */

import { useAppStore } from '@/store'
import {
  getEffectiveIdleAutoCloseMs,
  IDLE_RULE,
  resolveIdleAutoCloseGate,
  type IdleAutoCloseGate
} from '../../../../shared/idle-auto-close-settings'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import { recordHibernationLine } from './idle-auto-close-audit'
import { actOnIdleDecision, recordIdleDecision } from './idle-auto-close-acts'
import { isLocalDaemonPtyId, type IdleDecision, type IdleRule } from './idle-auto-close-decision'
import { createDefaultIdleAutoCloseDeps, type IdleAutoCloseDeps } from './idle-auto-close-deps'
import {
  clearObservations,
  hiddenSinceByWorktreeId,
  observeActiveWorktree,
  observeDaemonSessions,
  restartObservationClocks
} from './idle-auto-close-observations'
import { planBareShells } from './idle-auto-close-plan'
import { planHiddenBrowserDiscards } from './idle-auto-close-rules'
import { recheckIdleDecision } from './idle-auto-close-recheck'
import {
  clearSettledIdleTargets,
  idleGateKey,
  isIdleTargetSettled,
  pruneSettledIdleTargets,
  settleIdleTarget
} from './idle-auto-close-settled'
import { startPersonAttachTracking } from './idle-keep-guards'
import { startAgentPaneHistory } from './agent-pane-history'

export type { IdleAutoCloseDeps } from './idle-auto-close-deps'

export const IDLE_AUTO_CLOSE_TICK_MS = 60 * 1000
/** Most actions (or would-lines) one rule takes per tick; the rest wait for the next one. */
export const IDLE_AUTO_CLOSE_MAX_ACTIONS_PER_RULE_PER_TICK = 5
/** A gap this many intervals long means the computer slept or the clock jumped. */
const SLEEP_GAP_INTERVALS = 3
const SUMMARY_MIN_INTERVAL_MS = 15 * 60 * 1000

const coordinator = {
  interval: null as ReturnType<typeof setInterval> | null,
  intervalMs: IDLE_AUTO_CLOSE_TICK_MS,
  tickInFlight: false,
  now: (): number => Date.now(),
  lastTickAt: null as number | null,
  deps: createDefaultIdleAutoCloseDeps(),
  unsubscribe: null as (() => void) | null,
  /** rule|key -> signature seen last tick; an action needs two ticks that agree. */
  confirmation: new Map<string, string>(),
  lastSummary: null as { json: string; at: number } | null,
  /** Bumped by every stop; a tick started under an older generation acts on nothing more. */
  generation: 0
}

/**
 * The kill switch, read again before each single act or would-line (G4): not stopped since the
 * tick began, and the settings still resolve to the same gate. Why: the rechecks await main and
 * the process table, and a mode switched off meanwhile must stop what is left of the tick.
 */
function gateStillHolds(gate: IdleAutoCloseGate, generation: number): boolean {
  const current = resolveIdleAutoCloseGate(useAppStore.getState().settings)
  return (
    generation === coordinator.generation &&
    current.mode === gate.mode &&
    current.act === gate.act
  )
}

/** One line counting each rule's reasons, written when the counts change (at most every 15 min). */
function recordSummary(mode: 'shadow' | 'on', counts: Record<string, number>): void {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  const json = JSON.stringify(sorted)
  const now = coordinator.now()
  const last = coordinator.lastSummary
  if (last && (last.json === json || now - last.at < SUMMARY_MIN_INTERVAL_MS)) {
    return
  }
  coordinator.lastSummary = { json, at: now }
  recordHibernationLine({
    action: 'idle.summary',
    target: {},
    summary: 'Idle rules check: idle shell workspaces and hidden browser pages.',
    audit: {
      rule: IDLE_RULE.SUMMARY,
      mode,
      outcome: 'kept',
      evidence: Object.fromEntries(Object.entries(sorted).slice(0, 40))
    }
  })
}

async function planTick(now: number, sessions: PtyListedSession[]): Promise<IdleDecision[]> {
  const { deps } = coordinator
  const runtimeTerminals = await deps.listLocalTerminals()
  const state = useAppStore.getState()
  const idleMs = getEffectiveIdleAutoCloseMs(state.settings?.idleAutoCloseMinutes)
  return [
    ...(await planBareShells({
      deps,
      state,
      now,
      idleMs,
      sessionsById: new Map(sessions.map((session) => [session.id, session] as const)),
      runtimeTerminals
    })),
    ...planHiddenBrowserDiscards({
      now,
      idleMs,
      activeWorktreeId: state.activeWorktreeId,
      hiddenSinceByWorktreeId,
      holdsLiveGuests: (worktreeId) => deps.holdsLiveGuests(state, worktreeId),
      isEvictable: (worktreeId) => deps.isGuestEvictable(state, worktreeId),
      isPlayingAudio: (worktreeId) => deps.isGuestPlayingAudio(state, worktreeId)
    })
  ]
}

/** Two agreeing ticks, once per fact set and gate, at most five per rule per tick, re-checked. */
async function applyDecisions(
  gate: Exclude<IdleAutoCloseGate, { mode: 'off' }>,
  generation: number,
  decisions: readonly IdleDecision[],
  counts: Record<string, number>
): Promise<void> {
  const previous = coordinator.confirmation
  coordinator.confirmation = new Map()
  const gateKey = idleGateKey(gate)
  const actsByRule = new Map<IdleRule, number>()
  const sleptWorkspaces: string[] = []
  for (const decision of decisions) {
    if (decision.verdict !== 'act') {
      continue
    }
    const id = `${decision.rule}|${decision.key}`
    coordinator.confirmation.set(id, decision.signature)
    const count = actsByRule.get(decision.rule) ?? 0
    if (
      previous.get(id) !== decision.signature ||
      isIdleTargetSettled(id, decision.signature, gateKey, coordinator.now()) ||
      count >= IDLE_AUTO_CLOSE_MAX_ACTIONS_PER_RULE_PER_TICK
    ) {
      continue
    }
    actsByRule.set(decision.rule, count + 1)
    // G4: G1-G3 (and the shell's processes) re-read for this one target, right before it acts.
    const keep = await recheckIdleDecision(decision, coordinator.deps, coordinator.now())
    if (!gateStillHolds(gate, generation)) {
      break
    }
    const result = keep
      ? { kept: keep }
      : gate.act
        ? await actOnIdleDecision(
            coordinator.deps,
            decision,
            useAppStore.getState(),
            coordinator.now
          )
        : null
    if (result && 'kept' in result) {
      settleIdleTarget(id, decision.signature, gateKey, coordinator.now(), 'kept')
      const key = `${decision.rule.split('.')[1]}.recheck.${result.kept}`
      counts[key] = (counts[key] ?? 0) + 1
      continue
    }
    settleIdleTarget(id, decision.signature, gateKey, coordinator.now(), 'final')
    if (!result) {
      recordIdleDecision(decision, gate, 'would')
    } else if ('failed' in result) {
      recordIdleDecision(decision, gate, 'failed', { error: result.failed })
    } else {
      recordIdleDecision(decision, gate, 'done', result.evidence)
      if (decision.rule === IDLE_RULE.R2) {
        sleptWorkspaces.push(decision.key)
      }
    }
  }
  pruneSettledIdleTargets(coordinator.confirmation)
  if (sleptWorkspaces.length > 0) {
    coordinator.deps.notifySleptShellWorkspaces(sleptWorkspaces)
  }
}

export async function runIdleAutoCloseTick(): Promise<void> {
  if (coordinator.tickInFlight) {
    return
  }
  coordinator.tickInFlight = true
  try {
    const now = coordinator.now()
    const state = useAppStore.getState()
    const gate = resolveIdleAutoCloseGate(state.settings)
    if (gate.mode === 'off') {
      return
    }
    const generation = coordinator.generation
    const gap = coordinator.lastTickAt === null ? 0 : now - coordinator.lastTickAt
    coordinator.lastTickAt = now
    // Why: after a system sleep or a clock jump every clock restarts, and nothing acts this tick.
    if (gap < 0 || gap > SLEEP_GAP_INTERVALS * coordinator.intervalMs) {
      restartObservationClocks(now)
      coordinator.confirmation.clear()
      return
    }
    // Why: until reconnect publishes every wake hint, a restored tab looks unbound.
    if (!state.workspaceSessionReady) {
      return
    }
    observeActiveWorktree(state, now)
    let sessions: PtyListedSession[]
    try {
      sessions = (await coordinator.deps.listSessions()).filter((session) =>
        isLocalDaemonPtyId(session.id)
      )
    } catch {
      return
    }
    observeDaemonSessions(new Set(sessions.map((session) => session.id)), now)
    const decisions = await planTick(now, sessions)
    const counts: Record<string, number> = {}
    for (const decision of decisions) {
      const key = `${decision.rule.split('.')[1]}.${decision.reason}`
      counts[key] = (counts[key] ?? 0) + 1
    }
    if (gateStillHolds(gate, generation)) {
      await applyDecisions(gate, generation, decisions, counts)
    }
    if (gateStillHolds(gate, generation)) {
      recordSummary(gate.mode, counts)
    }
  } finally {
    coordinator.tickInFlight = false
  }
}

export function startIdleAutoCloseCoordinator(
  options: { intervalMs?: number; now?: () => number; deps?: Partial<IdleAutoCloseDeps> } = {}
): () => void {
  if (coordinator.interval !== null) {
    return stopIdleAutoCloseCoordinator
  }
  coordinator.now = options.now ?? (() => Date.now())
  coordinator.intervalMs = options.intervalMs ?? IDLE_AUTO_CLOSE_TICK_MS
  coordinator.deps = { ...createDefaultIdleAutoCloseDeps(), ...options.deps }
  coordinator.lastTickAt = null
  observeActiveWorktree(useAppStore.getState(), coordinator.now())
  const stopAttachTracking = startPersonAttachTracking(coordinator.now)
  const stopAgentPaneHistory = startAgentPaneHistory()
  const unsubscribeStore = useAppStore.subscribe((state, prev) => {
    if (state.activeWorktreeId !== prev.activeWorktreeId) {
      observeActiveWorktree(state, coordinator.now())
    }
  })
  coordinator.unsubscribe = () => {
    unsubscribeStore()
    stopAttachTracking()
    stopAgentPaneHistory()
  }
  coordinator.interval = setInterval(() => void runIdleAutoCloseTick(), coordinator.intervalMs)
  return stopIdleAutoCloseCoordinator
}

export function stopIdleAutoCloseCoordinator(): void {
  coordinator.generation += 1
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.unsubscribe?.()
  coordinator.unsubscribe = null
  coordinator.confirmation.clear()
  clearSettledIdleTargets()
  coordinator.lastTickAt = null
  clearObservations()
}

export function resetIdleAutoCloseCoordinatorForTests(): void {
  stopIdleAutoCloseCoordinator()
  coordinator.tickInFlight = false
  coordinator.now = () => Date.now()
  coordinator.deps = createDefaultIdleAutoCloseDeps()
  coordinator.lastSummary = null
}
