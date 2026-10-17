import type { AutomationRun } from '../../shared/automations-types'
import {
  CLEANUP_AUTOMATIC_DAILY_CAP,
  type CleanupRunRow,
  type CleanupRunSource,
  type CleanupRunsView
} from '../../shared/session-cleanup-run'
import { automaticTakenOn, localDay, type CleanupState } from './cleanup-reservation-store'

const REPORT_CHARS = 1500
const VIEW_RUNS = 5
const VIEW_SKIPS = 5

export function cleanupRunSource(run: Pick<AutomationRun, 'trigger'>): CleanupRunSource {
  return run.trigger === 'automatic' ? 'automatic' : 'manual'
}

/** The session's final answer without the routine's machine-readable trailer, clipped. */
export function cleanupReport(content: string | null | undefined): string | null {
  const text = content
    ?.replace(/```routine-result[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) {
    return null
  }
  return text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS - 1)}…` : text
}

export function cleanupRunRow(run: AutomationRun): CleanupRunRow {
  return {
    runId: run.id,
    source: cleanupRunSource(run),
    status: run.status,
    title: run.title,
    createdAt: run.createdAt,
    paneKey: run.terminalPaneKey,
    report: cleanupReport(run.outputSnapshot?.content),
    error: run.error
  }
}

/** What Work shows: the slot, the latest runs with their reports, and recent skips. */
export function cleanupRunsView(input: {
  state: CleanupState
  history: readonly AutomationRun[]
  now: number
  automaticOn: boolean
}): CleanupRunsView {
  const runs = input.history.filter((run) => run.trigger !== 'scheduled')
  const active = input.state.active
  const activeRun = active?.runId ? runs.find((run) => run.id === active.runId) : undefined
  return {
    active: active
      ? {
          source: active.source,
          takenAt: active.takenAt,
          run: activeRun ? cleanupRunRow(activeRun) : null
        }
      : null,
    runs: runs.slice(0, VIEW_RUNS).map(cleanupRunRow),
    skipped: input.state.skipped.slice(-VIEW_SKIPS).toReversed(),
    automaticToday: automaticTakenOn(input.state, localDay(input.now)),
    dailyCap: CLEANUP_AUTOMATIC_DAILY_CAP,
    automaticOn: input.automaticOn
  }
}
