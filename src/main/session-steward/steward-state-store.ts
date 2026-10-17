/**
 * The steward's own durable state, `<userData>/session-steward/state.json`: per-session limits and
 * readings (keyed by pane), today's prompt count (reported, never capped), prompt intents and the activity trail.
 * Every change is saved before the call that made it returns, so a limit is spent before anything
 * is sent, and a crash between the two can only leave a limit spent, never a prompt sent twice.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SESSION_STEWARD_ACTIVITY_KINDS,
  type SessionStewardActivity
} from '../../shared/session-steward-status'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const STEWARD_DIRECTORY = 'session-steward'
export const STEWARD_STATE_FILE = 'state.json'
const MAX_SESSIONS = 500
const MAX_ACTIVITY = 300
const ACTIVITY_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const TEXT_MAX = 600

export type StewardYesState = {
  /** Local day (`YYYY-MM-DD`) the count is for. */
  day: string
  count: number
  lastTurnKey?: string
  /** Git head and changes when the last Yes was pressed; null when unreadable. */
  lastEvidence?: string | null
  /** Turns in a row that brought no new evidence since a Yes. */
  noEvidenceTurns: number
}

export type StewardSessionState = {
  title?: string
  yes?: StewardYesState
  nudge?: { count: number; lastAt: number; lastTurnKey?: string | null }
  ask?: { at: number; turnKey?: string | null }
  stalled?: { at: number; reason: string; turnKey?: string | null }
  silent?: { since: number; minutes: number }
  updatedAt: number
}

/** A prompt granted and not yet settled; one left at start was interrupted and is never resent. */
export type StewardIntent = {
  id: string
  paneKey: string
  kind: 'yes' | 'prompt' | 'ask'
  at: number
}

export type StewardStateData = {
  sessions: Record<string, StewardSessionState>
  daily: { day: string; prompts: number }
  intents: StewardIntent[]
  activity: SessionStewardActivity[]
}

/** The local calendar day of `at`, as `YYYY-MM-DD`. */
export function stewardDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function emptyData(now: number): StewardStateData {
  return { sessions: {}, daily: { day: stewardDay(now), prompts: 0 }, intents: [], activity: [] }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function parseActivity(value: unknown): SessionStewardActivity | null {
  if (
    !isRecord(value) ||
    !finite(value.at) ||
    typeof value.summary !== 'string' ||
    !(SESSION_STEWARD_ACTIVITY_KINDS as readonly unknown[]).includes(value.kind)
  ) {
    return null
  }
  return value as SessionStewardActivity
}

function parseIntent(value: unknown): StewardIntent | null {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.paneKey === 'string' &&
    ['yes', 'prompt', 'ask'].includes(value.kind as string) &&
    finite(value.at)
    ? (value as StewardIntent)
    : null
}

/** Field by field; anything unreadable is dropped (a dropped limit re-arms, never over-sends). */
export function parseStewardState(raw: unknown, now: number): StewardStateData {
  const data = emptyData(now)
  if (!isRecord(raw)) {
    return data
  }
  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions)) {
      if (isRecord(value) && finite(value.updatedAt)) {
        data.sessions[key] = value as StewardSessionState
      }
    }
  }
  if (isRecord(raw.daily) && typeof raw.daily.day === 'string' && finite(raw.daily.prompts)) {
    data.daily = { day: raw.daily.day, prompts: raw.daily.prompts }
  }
  if (Array.isArray(raw.intents)) {
    data.intents = raw.intents.map(parseIntent).filter((entry) => entry !== null)
  }
  if (Array.isArray(raw.activity)) {
    data.activity = raw.activity.map(parseActivity).filter((entry) => entry !== null)
  }
  return data
}

function prune(data: StewardStateData, now: number): void {
  const keys = Object.keys(data.sessions)
  if (keys.length > MAX_SESSIONS) {
    const oldest = keys
      .toSorted((left, right) => data.sessions[left]!.updatedAt - data.sessions[right]!.updatedAt)
      .slice(0, keys.length - MAX_SESSIONS)
    for (const key of oldest) {
      delete data.sessions[key]
    }
  }
  data.activity = data.activity
    .filter((entry) => now - entry.at <= ACTIVITY_MAX_AGE_MS)
    .slice(-MAX_ACTIVITY)
}

export class StewardStateStore {
  private data: StewardStateData
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: { directory: string; now?: () => number }) {
    this.data = emptyData(this.now())
  }

  get path(): string {
    return join(this.options.directory, STEWARD_STATE_FILE)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Reads the saved state once; returns the intents a previous process left unsettled. */
  load(): StewardIntent[] {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return []
    }
    this.data = parseStewardState(raw, this.now())
    return [...this.data.intents]
  }

  /** The current state; read only (change it through `transact`). */
  read(): Readonly<StewardStateData> {
    return this.data
  }

  session(paneKey: string): StewardSessionState | undefined {
    return this.data.sessions[paneKey]
  }

  /**
   * Runs `change` on a copy under the write lock and saves it durably before resolving; a failed
   * save leaves the state as it was and rejects, so nothing may act on it.
   */
  transact<T>(change: (data: StewardStateData) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const next = structuredClone(this.data)
      const result = change(next)
      prune(next, this.now())
      await mkdir(this.options.directory, { recursive: true })
      await writeFileDurable(durableWriteTempPath(this.path), this.path, JSON.stringify(next))
      this.data = next
      return result
    })
    this.chain = run.catch(() => {})
    return run
  }

  /** One activity line; a failed save is logged, never thrown (the action already happened). */
  note(entry: Omit<SessionStewardActivity, 'at'> & { at?: number }): Promise<void> {
    const line: SessionStewardActivity = {
      ...entry,
      at: entry.at ?? this.now(),
      summary: entry.summary.slice(0, TEXT_MAX)
    }
    return this.transact((data) => {
      data.activity.push(line)
    }).catch((error: unknown) => console.warn('[session-steward] saving activity failed', error))
  }

  flush(): Promise<void> {
    return this.chain.then(() => undefined)
  }
}
