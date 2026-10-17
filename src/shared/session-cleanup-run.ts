/**
 * One-off cleanup sessions (D7-A): started by the app when leftovers pile up, or by Clean up now
 * in Work. One durable reservation in main admits both, one run at a time; automatic runs at most
 * `CLEANUP_AUTOMATIC_DAILY_CAP` a day, counted by reservations taken. docs/reference/session-steward.md.
 */

import type { AutomationRunStatus } from './automations-types'

export const SESSION_CLEANUP_RPC = {
  now: 'sessionSteward.cleanupNow',
  runs: 'sessionSteward.cleanupRuns'
} as const

export type CleanupRunSource = 'automatic' | 'manual'

export const CLEANUP_AUTOMATIC_DAILY_CAP = 3

export type CleanupRefusalReason = 'running' | 'daily-cap' | 'capacity' | 'disabled'

export type CleanupAdmission =
  | { ok: true; reservationId: string }
  | { ok: false; reason: CleanupRefusalReason; detail: string }

/** One cleanup session, read from the automation's run history. */
export type CleanupRunRow = {
  runId: string
  source: CleanupRunSource
  status: AutomationRunStatus
  title: string
  createdAt: number
  paneKey: string | null
  /** The session's final answer, clipped; null until it reports. */
  report: string | null
  error: string | null
}

/** An admission the detector could not take, folded with its repeats. */
export type CleanupSkipRow = {
  at: number
  reason: CleanupRefusalReason
  /** `capacity (codex)`, `3 automatic runs today`, … */
  detail: string
  /** Plain words on why, when the reason has more to say. */
  why?: string
  count: number
}

export type CleanupRunsView = {
  /** The reservation holding the one slot, with its run once it exists. */
  active: { source: CleanupRunSource; takenAt: number; run: CleanupRunRow | null } | null
  runs: CleanupRunRow[]
  skipped: CleanupSkipRow[]
  automaticToday: number
  dailyCap: number
  automaticOn: boolean
}
