/**
 * The clocks the idle rules read that no store field holds: when this window first saw each daemon
 * PTY, since when each browser workspace has been hidden, and the recent process inspections.
 * Module state with an injected `now`, reset between tests.
 */

import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import type { ProcessInspection } from './idle-auto-close-decision'

/** A bare-shell inspection is reused this long unless the shell printed since. */
export const IDLE_AUTO_CLOSE_INSPECTION_TTL_MS = 10 * 60 * 1000

export const firstObservedAtByPtyId = new Map<string, number>()
export const hiddenSinceByWorktreeId = new Map<string, number>()
const inspections = new Map<
  string,
  { at: number; lastOutputAt: number | null; result: ProcessInspection }
>()

/** Browser workspaces that can be hidden: every one but the floating panel's, shown over all. */
function browserWorktreeIds(state: AppState): string[] {
  return Object.entries(state.browserTabsByWorktree ?? {})
    .filter(([worktreeId, tabs]) => worktreeId !== FLOATING_TERMINAL_WORKTREE_ID && tabs.length > 0)
    .map(([worktreeId]) => worktreeId)
}

/** Switching away starts a workspace's hidden clock; showing it again clears the clock. */
export function observeActiveWorktree(state: AppState, now: number): void {
  const present = new Set(browserWorktreeIds(state))
  for (const worktreeId of hiddenSinceByWorktreeId.keys()) {
    if (!present.has(worktreeId) || worktreeId === state.activeWorktreeId) {
      hiddenSinceByWorktreeId.delete(worktreeId)
    }
  }
  for (const worktreeId of present) {
    if (worktreeId !== state.activeWorktreeId && !hiddenSinceByWorktreeId.has(worktreeId)) {
      hiddenSinceByWorktreeId.set(worktreeId, now)
    }
  }
}

/** First sight of each listed PTY; PTYs the daemon no longer lists are forgotten. */
export function observeDaemonSessions(ptyIds: ReadonlySet<string>, now: number): void {
  for (const ptyId of ptyIds) {
    if (!firstObservedAtByPtyId.has(ptyId)) {
      firstObservedAtByPtyId.set(ptyId, now)
    }
  }
  for (const ptyId of firstObservedAtByPtyId.keys()) {
    if (!ptyIds.has(ptyId)) {
      firstObservedAtByPtyId.delete(ptyId)
    }
  }
}

export function rememberInspection(
  ptyId: string,
  result: ProcessInspection,
  lastOutputAt: number | null,
  now: number
): void {
  inspections.set(ptyId, { at: now, lastOutputAt, result })
}

/** Inspections still valid: younger than the TTL and with no output since they were taken. */
export function currentInspections(
  runtimeTerminalsByPtyId: ReadonlyMap<string, RuntimeTerminalSummary>,
  now: number
): Map<string, ProcessInspection> {
  const current = new Map<string, ProcessInspection>()
  for (const [ptyId, cached] of inspections) {
    const lastOutputAt = runtimeTerminalsByPtyId.get(ptyId)?.lastOutputAt ?? null
    // Why: output since the inspection may be a command that started; look again.
    if (
      now - cached.at > IDLE_AUTO_CLOSE_INSPECTION_TTL_MS ||
      lastOutputAt !== cached.lastOutputAt
    ) {
      inspections.delete(ptyId)
      continue
    }
    current.set(ptyId, cached.result)
  }
  return current
}

/** After a system sleep or clock jump every clock restarts now, so nothing looks idle at once. */
export function restartObservationClocks(now: number): void {
  for (const map of [firstObservedAtByPtyId, hiddenSinceByWorktreeId]) {
    for (const key of map.keys()) {
      map.set(key, now)
    }
  }
  inspections.clear()
}

export function clearObservations(): void {
  firstObservedAtByPtyId.clear()
  hiddenSinceByWorktreeId.clear()
  inspections.clear()
}
