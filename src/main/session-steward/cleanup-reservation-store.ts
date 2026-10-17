/**
 * `<userData>/session-steward/cleanup.json`: the one cleanup slot and the reservations taken.
 * Written synchronously and durably before an admission returns, so a crash can never forget a
 * reservation it granted (main is single-threaded: admission is atomic by construction).
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AutomationRunStatus } from '../../shared/automations-types'
import type {
  CleanupRefusalReason,
  CleanupRunSource,
  CleanupSkipRow
} from '../../shared/session-cleanup-run'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export type CleanupReservation = {
  reservationId: string
  source: CleanupRunSource
  takenAt: number
  /** Bound once the automation run exists; its status decides when the slot frees. */
  runId?: string
}

export type CleanupTaken = {
  reservationId: string
  source: CleanupRunSource
  /** Local calendar day, `YYYY-MM-DD`: the daily cap counts these. */
  day: string
  at: number
  runId?: string
  paneKey?: string
  /** How it ended: the run's final status, or `not-started` when no run was ever created. */
  outcome?: AutomationRunStatus | 'not-started' | 'lost'
}

export type CleanupState = {
  version: 1
  automationId?: string
  active?: CleanupReservation
  taken: CleanupTaken[]
  skipped: CleanupSkipRow[]
}

const TAKEN_KEEP = 60
const SKIPPED_KEEP = 20
const REFUSAL_REASONS: readonly CleanupRefusalReason[] = [
  'running',
  'daily-cap',
  'capacity',
  'disabled'
]

export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSource(value: unknown): value is CleanupRunSource {
  return value === 'automatic' || value === 'manual'
}

function readReservation(value: unknown): CleanupReservation | undefined {
  if (
    !isRecord(value) ||
    typeof value.reservationId !== 'string' ||
    !isSource(value.source) ||
    typeof value.takenAt !== 'number'
  ) {
    return undefined
  }
  return {
    reservationId: value.reservationId,
    source: value.source,
    takenAt: value.takenAt,
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {})
  }
}

function readTaken(value: unknown): CleanupTaken | null {
  const base = readReservation(isRecord(value) ? { ...value, takenAt: value.at } : value)
  if (!base || !isRecord(value) || typeof value.day !== 'string') {
    return null
  }
  return {
    reservationId: base.reservationId,
    source: base.source,
    day: value.day,
    at: base.takenAt,
    ...(base.runId ? { runId: base.runId } : {}),
    ...(typeof value.paneKey === 'string' ? { paneKey: value.paneKey } : {}),
    ...(typeof value.outcome === 'string'
      ? { outcome: value.outcome as NonNullable<CleanupTaken['outcome']> }
      : {})
  }
}

function readSkip(value: unknown): CleanupSkipRow | null {
  if (
    !isRecord(value) ||
    typeof value.at !== 'number' ||
    !REFUSAL_REASONS.includes(value.reason as CleanupRefusalReason) ||
    typeof value.detail !== 'string' ||
    typeof value.count !== 'number'
  ) {
    return null
  }
  return {
    at: value.at,
    reason: value.reason as CleanupRefusalReason,
    detail: value.detail,
    ...(typeof value.why === 'string' ? { why: value.why } : {}),
    count: value.count
  }
}

/** A readable file, or `null` when it exists but cannot be trusted (the caller rebuilds). */
export function parseCleanupState(raw: string): CleanupState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.taken)) {
    return null
  }
  const active = readReservation(parsed.active)
  return {
    version: 1,
    ...(typeof parsed.automationId === 'string' ? { automationId: parsed.automationId } : {}),
    ...(active ? { active } : {}),
    taken: parsed.taken.map(readTaken).filter((entry): entry is CleanupTaken => entry !== null),
    skipped: (Array.isArray(parsed.skipped) ? parsed.skipped : [])
      .map(readSkip)
      .filter((entry): entry is CleanupSkipRow => entry !== null)
  }
}

export function emptyCleanupState(): CleanupState {
  return { version: 1, taken: [], skipped: [] }
}

export class CleanupReservationStore {
  constructor(private readonly path: string) {}

  /** `corrupt` is true when a file existed but could not be read; the caller must rebuild. */
  read(): { state: CleanupState; corrupt: boolean } {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return { state: emptyCleanupState(), corrupt: false }
    }
    const state = parseCleanupState(raw)
    return state ? { state, corrupt: false } : { state: emptyCleanupState(), corrupt: true }
  }

  write(state: CleanupState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const bounded: CleanupState = {
      ...state,
      taken: state.taken.slice(-TAKEN_KEEP),
      skipped: state.skipped.slice(-SKIPPED_KEEP)
    }
    writeFileDurableSync(
      durableWriteTempPath(this.path),
      this.path,
      `${JSON.stringify(bounded, null, 2)}\n`
    )
  }
}

/** Repeats of the latest skip fold into it, so a detector asking every minute writes one row. */
export function recordCleanupSkip(
  state: CleanupState,
  skip: Omit<CleanupSkipRow, 'count'>
): CleanupState {
  const latest = state.skipped.at(-1)
  if (latest && latest.reason === skip.reason && latest.detail === skip.detail) {
    return {
      ...state,
      skipped: [
        ...state.skipped.slice(0, -1),
        { ...latest, at: skip.at, ...(skip.why ? { why: skip.why } : {}), count: latest.count + 1 }
      ]
    }
  }
  return { ...state, skipped: [...state.skipped, { ...skip, count: 1 }] }
}

export function automaticTakenOn(state: CleanupState, day: string): number {
  return state.taken.filter((entry) => entry.source === 'automatic' && entry.day === day).length
}
