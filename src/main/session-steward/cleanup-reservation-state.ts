/**
 * Pure readings and transitions of the cleanup record against the automation's run history: the
 * run a reservation holds, settling it, the pane an automatic run owns, and rebuilding a record
 * that could not be read.
 */

import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../shared/automations-types'
import type { SessionManageUnattended } from '../../shared/session-manage-types'
import type {
  LingeringAutomaticCleanupRun,
  LiveAutomaticCleanupRun
} from './cleanup-run-caller-binding'
import { cleanupRunSource } from './cleanup-run-rows'
import {
  localDay,
  type CleanupReservation,
  type CleanupState,
  type CleanupTaken
} from './cleanup-reservation-store'

/** A run created within this much before its reservation's clock still belongs to it. */
const BIND_SKEW_MS = 1_000

function belongsTo(run: AutomationRun, reservation: CleanupReservation): boolean {
  return (
    cleanupRunSource(run) === reservation.source &&
    run.createdAt >= reservation.takenAt - BIND_SKEW_MS
  )
}

/** The reservation's run: the one bound to it, else the first created after it was taken. */
export function reservationRun(
  reservation: CleanupReservation,
  runs: readonly AutomationRun[]
): AutomationRun | undefined {
  return reservation.runId
    ? runs.find((run) => run.id === reservation.runId)
    : runs.findLast((run) => belongsTo(run, reservation))
}

/** Whether a run just written is the one an unbound reservation is waiting for. */
export function isReservationRun(reservation: CleanupReservation, run: AutomationRun): boolean {
  return !reservation.runId && belongsTo(run, reservation)
}

export function bindReservation(
  state: CleanupState,
  reservationId: string,
  runId: string
): CleanupState {
  return {
    ...state,
    ...(state.active?.reservationId === reservationId
      ? { active: { ...state.active, runId } }
      : {}),
    taken: state.taken.map((entry) =>
      entry.reservationId === reservationId ? { ...entry, runId } : entry
    )
  }
}

export function settleReservation(
  state: CleanupState,
  reservationId: string,
  outcome: NonNullable<CleanupTaken['outcome']>
): CleanupState {
  const { active, ...rest } = state
  return {
    ...rest,
    ...(active && active.reservationId !== reservationId ? { active } : {}),
    taken: state.taken.map((entry) =>
      entry.reservationId === reservationId ? { ...entry, outcome } : entry
    )
  }
}

/** Remembers an automatic run's pane past the run history's retention; null when unchanged. */
export function rememberRunPane(
  state: CleanupState,
  runId: string,
  paneKey: string
): CleanupState | null {
  if (!state.taken.some((entry) => entry.runId === runId && entry.paneKey !== paneKey)) {
    return null
  }
  return {
    ...state,
    taken: state.taken.map((entry) => (entry.runId === runId ? { ...entry, paneKey } : entry))
  }
}

/** An automatic run's pane is unattended for the whole life of that pane (S1's resolver). */
export function cleanupPaneContext(
  state: CleanupState,
  runs: readonly AutomationRun[],
  paneKey: string
): SessionManageUnattended | null {
  const run = runs.find(
    (entry) => entry.trigger === 'automatic' && entry.terminalPaneKey === paneKey
  )
  if (run) {
    return { source: 'cleanup-run', runId: run.id, since: run.createdAt }
  }
  const taken = state.taken.find(
    (entry) => entry.source === 'automatic' && entry.paneKey === paneKey
  )
  return taken
    ? { source: 'cleanup-run', ...(taken.runId ? { runId: taken.runId } : {}), since: taken.at }
    : null
}

/** How long after it started a finished automatic run's terminal is still checked (End closes it). */
export const CLEANUP_LINGER_MS = 2 * 60 * 60 * 1000

/** Finished automatic runs whose terminals may still be open, for the process-tree binding. */
export function lingeringAutomaticCleanupRuns(
  runs: readonly AutomationRun[],
  now: number
): LingeringAutomaticCleanupRun[] {
  return runs.flatMap((run) =>
    run.trigger === 'automatic' &&
    run.terminalPtyId &&
    isFinalAutomationRunStatus(run.status) &&
    now - run.createdAt <= CLEANUP_LINGER_MS
      ? [
          {
            context: { source: 'cleanup-run' as const, runId: run.id, since: run.createdAt },
            ptyId: run.terminalPtyId
          }
        ]
      : []
  )
}

/** The automatic run holding the slot now, for the process-tree binding. */
export function liveAutomaticCleanupRun(
  state: CleanupState,
  runs: readonly AutomationRun[],
  workspaceId: string | null
): LiveAutomaticCleanupRun | null {
  const active = state.active
  if (!active || active.source !== 'automatic') {
    return null
  }
  const run = active.runId ? runs.find((entry) => entry.id === active.runId) : undefined
  if (run && isFinalAutomationRunStatus(run.status)) {
    return null
  }
  return {
    context: {
      source: 'cleanup-run',
      ...(active.runId ? { runId: active.runId } : {}),
      since: active.takenAt
    },
    ptyId: run?.terminalPtyId ?? null,
    paneKey: run?.terminalPaneKey ?? null,
    workspaceId,
    manualPaneKeys: new Set(
      runs.flatMap((entry) =>
        entry.trigger === 'manual' && entry.terminalPaneKey ? [entry.terminalPaneKey] : []
      )
    )
  }
}

/** An unreadable record, rebuilt from the run history: any live run keeps its slot. */
export function rebuildCleanupState(
  automation: Automation | null,
  history: readonly AutomationRun[]
): CleanupState {
  const runs = history.filter((run) => run.trigger !== 'scheduled')
  const live = runs.find((run) => !isFinalAutomationRunStatus(run.status))
  return {
    version: 1,
    ...(automation ? { automationId: automation.id } : {}),
    ...(live
      ? {
          active: {
            reservationId: `rebuilt:${live.id}`,
            source: cleanupRunSource(live),
            takenAt: live.createdAt,
            runId: live.id
          }
        }
      : {}),
    taken: runs.toReversed().map((run) => ({
      reservationId: `rebuilt:${run.id}`,
      source: cleanupRunSource(run),
      day: localDay(run.createdAt),
      at: run.createdAt,
      runId: run.id,
      ...(run.terminalPaneKey ? { paneKey: run.terminalPaneKey } : {})
    })),
    skipped: []
  }
}
