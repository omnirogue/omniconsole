/**
 * Every wake of a slept agent, whatever woke it, as one `hibernation.wake` line — and the thrash
 * breaker: a pane woken within 30 minutes of its last sleep is exempt from agent sleep for the rest
 * of this app session (two archived panes slept and relaunched every 12 minutes on 2026-09-30).
 *
 * A wake is a slept record (origin 'worktree-sleep', state 'done': what hibernation and a person's
 * sleep write) leaving the store while its own pane binds a live PTY again, after the PTY it slept
 * on went down. A record that leaves because its tab closed is not a wake, and neither is one a
 * failed shutdown rolled back while its pane still held the same live PTY.
 */

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { HIBERNATION_THRASH_WINDOW_MS, IDLE_RULE } from '../../../shared/idle-auto-close-settings'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getForegroundTerminalTabIds } from './foreground-terminal-tabs'
import { recordHibernationLine } from './idle-auto-close/idle-auto-close-audit'
import { isTerminalTabRendererVisible } from './terminal-pane-visibility-registry'

/** A removed record whose pane has not bound a PTY within this long was cleared, not woken. */
export const WAKE_BIND_GRACE_MS = 2 * 60 * 1000

type PendingWake = { record: SleepingAgentSessionRecord; removedAt: number }
/** A slept record's pane: the live PTY it held when the record appeared, and whether it went down. */
type SleptPane = { ptyId: string | null; down: boolean }

const thrashExemptPaneKeys = new Set<string>()
const pendingWakeByPaneKey = new Map<string, PendingWake>()
const sleptPaneByPaneKey = new Map<string, SleptPane>()
let unsubscribe: (() => void) | null = null
let clock: () => number = () => Date.now()

export function isThrashExempt(paneKey: string): boolean {
  return thrashExemptPaneKeys.has(paneKey)
}

export function getThrashExemptPaneCount(): number {
  return thrashExemptPaneKeys.size
}

function isSleptRecord(record: SleepingAgentSessionRecord | undefined): boolean {
  return record?.origin === 'worktree-sleep' && record.state === 'done'
}

/** The live PTY bound to the record's own pane, or null. */
function liveBoundPtyId(
  state: AppState,
  paneKey: string,
  record: SleepingAgentSessionRecord
): string | null {
  const parsed = parsePaneKey(paneKey)
  const tabId = record.tabId ?? parsed?.tabId
  if (!parsed || !tabId) {
    return null
  }
  const boundPtyId = state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[parsed.leafId]
  return boundPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(boundPtyId) ? boundPtyId : null
}

/**
 * Follows each slept record's PTY: hibernation writes the record before its kill, so the pane still
 * holds the PTY when the record appears. Why: a failed kill rolls the record back while that PTY
 * stays live, and counting that as a wake logged a fake sleep->wake pair and exempted the pane.
 */
function trackSleptPanes(state: AppState): void {
  const records = state.sleepingAgentSessionsByPaneKey ?? {}
  for (const [paneKey, record] of Object.entries(records)) {
    if (!isSleptRecord(record)) {
      sleptPaneByPaneKey.delete(paneKey)
      continue
    }
    const bound = liveBoundPtyId(state, paneKey, record)
    const tracked = sleptPaneByPaneKey.get(paneKey)
    if (!tracked) {
      sleptPaneByPaneKey.set(paneKey, { ptyId: bound, down: bound === null })
    } else if (!tracked.down && bound !== tracked.ptyId) {
      tracked.down = true
    }
  }
}

function noteRemovedRecords(state: AppState, prev: AppState, now: number): void {
  for (const [paneKey, record] of Object.entries(prev.sleepingAgentSessionsByPaneKey ?? {})) {
    if (state.sleepingAgentSessionsByPaneKey?.[paneKey]) {
      continue
    }
    const slept = sleptPaneByPaneKey.get(paneKey)
    sleptPaneByPaneKey.delete(paneKey)
    const stillOnItsPty =
      slept !== undefined &&
      !slept.down &&
      slept.ptyId !== null &&
      liveBoundPtyId(state, paneKey, record) === slept.ptyId
    if (isSleptRecord(record) && !stillOnItsPty) {
      pendingWakeByPaneKey.set(paneKey, { record, removedAt: now })
    }
  }
  // A pane slept again before it bound is no longer waking.
  for (const paneKey of pendingWakeByPaneKey.keys()) {
    if (state.sleepingAgentSessionsByPaneKey?.[paneKey]) {
      pendingWakeByPaneKey.delete(paneKey)
    }
  }
}

function recordWake(paneKey: string, tabId: string, pending: PendingWake, now: number): void {
  const sleptAt = pending.record.capturedAt
  const sleptForMs = Math.max(0, now - sleptAt)
  const thrash = sleptForMs < HIBERNATION_THRASH_WINDOW_MS
  if (thrash) {
    thrashExemptPaneKeys.add(paneKey)
  }
  recordHibernationLine({
    action: 'hibernation.wake',
    target: { paneKey, tabId },
    summary: thrash
      ? `A slept agent woke ${Math.round(sleptForMs / 1000)} s after its sleep; agent sleep leaves it alone for this app session.`
      : `A slept agent woke after ${Math.round(sleptForMs / 60_000)} minutes asleep.`,
    audit: {
      rule: IDLE_RULE.WAKE,
      mode: 'on',
      outcome: 'done',
      evidence: {
        worktreeId: pending.record.worktreeId,
        sleptAt,
        sleptForMs,
        thrashExempt: thrash,
        visibleAtWake: isTerminalTabRendererVisible(tabId),
        foregroundAtWake: getForegroundTerminalTabIds().includes(tabId),
        restoreOnTabOpenOnly: pending.record.restoreOnTabOpenOnly === true,
        resumeOnFirstReveal: pending.record.resumeOnFirstReveal === true,
        agent: pending.record.agent
      }
    }
  })
}

/** Resolves pending wakes against the store: bound again (a wake), tab gone or too late (not). */
export function checkPendingWakes(state: AppState, now: number): void {
  for (const [paneKey, pending] of pendingWakeByPaneKey) {
    const parsed = parsePaneKey(paneKey)
    const tabId = pending.record.tabId ?? parsed?.tabId
    const tabExists =
      tabId !== undefined &&
      (state.tabsByWorktree?.[pending.record.worktreeId] ?? []).some((tab) => tab.id === tabId)
    if (!parsed || !tabId || !tabExists) {
      pendingWakeByPaneKey.delete(paneKey)
      continue
    }
    const boundPtyId = state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    if (boundPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(boundPtyId)) {
      pendingWakeByPaneKey.delete(paneKey)
      recordWake(paneKey, tabId, pending, now)
    } else if (now - pending.removedAt > WAKE_BIND_GRACE_MS) {
      pendingWakeByPaneKey.delete(paneKey)
    }
  }
}

export function startAgentSleepWakeTracker(now: () => number = () => Date.now()): () => void {
  clock = now
  if (unsubscribe) {
    return stopAgentSleepWakeTracker
  }
  trackSleptPanes(useAppStore.getState())
  unsubscribe = useAppStore.subscribe((state, prev) => {
    if (
      state.sleepingAgentSessionsByPaneKey !== prev.sleepingAgentSessionsByPaneKey ||
      (sleptPaneByPaneKey.size > 0 &&
        (state.ptyIdsByTabId !== prev.ptyIdsByTabId ||
          state.terminalLayoutsByTabId !== prev.terminalLayoutsByTabId))
    ) {
      trackSleptPanes(state)
    }
    if (state.sleepingAgentSessionsByPaneKey !== prev.sleepingAgentSessionsByPaneKey) {
      noteRemovedRecords(state, prev, clock())
    }
    if (pendingWakeByPaneKey.size > 0) {
      checkPendingWakes(state, clock())
    }
  })
  return stopAgentSleepWakeTracker
}

export function stopAgentSleepWakeTracker(): void {
  unsubscribe?.()
  unsubscribe = null
  pendingWakeByPaneKey.clear()
  sleptPaneByPaneKey.clear()
}

export function resetAgentSleepWakeTrackerForTests(): void {
  stopAgentSleepWakeTracker()
  thrashExemptPaneKeys.clear()
  clock = () => Date.now()
}
