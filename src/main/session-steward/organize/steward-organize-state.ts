/**
 * `<userData>/session-steward/organize-state.json`: what the steward's organizing remembers
 * between passes: each session's folder readings, when it last moved a session, its "same project"
 * pair readings, today's pair-read count (the `pairReadsPerDay` budget) and the goal each session
 * was last seen pursuing, with its task card and drift readings (re-titling).
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'

export const STEWARD_ORGANIZE_STATE_FILE = 'organize-state.json'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Readings older than this never confirm a move. */
export const STEWARD_READING_KEEP_MS = 3 * DAY_MS
const READINGS_PER_SESSION = 4
/** A "same project" answer is reused this long before JEV is asked again. */
export const STEWARD_PAIR_KEEP_MS = 3 * DAY_MS
/** A session's goal is remembered this long without activity. */
const GOAL_KEEP_MS = 30 * DAY_MS

export type StewardFolderReadingRecord = {
  /** Null is "no folder fits". */
  folderId: string | null
  confidence: number
  at: number
  /** The session's activity when read: a new turn earns a new reading. */
  turnKey: string
}

type OrganizeStateFile = {
  version: 1
  readings: Record<string, StewardFolderReadingRecord[]>
  moves: Record<string, number>
  pairs: Record<string, { value: number | null; at: number }>
  pairReads: { day: string; count: number }
  goals: Record<string, StewardGoalMemory>
}

/** The goal a session was pursuing when last read (its position among its goals), and when. */
export type StewardGoalMemory = {
  goalKey: string | null
  index: number
  turnKey: string
  /** The attached task card as last read (id and title); null with none. */
  cardKey: string | null
  /** Last compact-summary title considered; older state has none. */
  summaryTitle?: string | null
  /** The last two "still on goal" readings of distinct finished turns. */
  drift: { turnKey: string; score: number }[]
  at: number
}

function empty(): OrganizeStateFile {
  return {
    version: 1,
    readings: {},
    moves: {},
    pairs: {},
    pairReads: { day: '', count: 0 },
    goals: {}
  }
}

function record<T>(raw: unknown): Record<string, T> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, T>) : {}
}

/** The UTC day a pair read counts against. */
export function stewardOrganizeDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

export class StewardOrganizeState {
  private data: OrganizeStateFile = empty()
  private loaded = false
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      /** `<userData>/session-steward`. */
      directory: string
      now?: () => number
    }
  ) {}

  get path(): string {
    return join(this.options.directory, STEWARD_ORGANIZE_STATE_FILE)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Newest last. */
  readings(key: string): StewardFolderReadingRecord[] {
    return [...(this.state().readings[key] ?? [])]
  }

  addReading(key: string, reading: StewardFolderReadingRecord): void {
    const kept = this.readings(key).filter(
      (entry) => reading.at - entry.at < STEWARD_READING_KEEP_MS
    )
    this.state().readings[key] = [...kept, reading].slice(-READINGS_PER_SESSION)
    this.persist()
  }

  lastMoveAt(key: string): number | null {
    return this.state().moves[key] ?? null
  }

  /** A move starts over: the next one needs two fresh readings. */
  noteMove(key: string, at: number): void {
    const data = this.state()
    data.moves[key] = at
    delete data.readings[key]
    this.persist()
  }

  pair(pairKey: string): number | null | undefined {
    const entry = this.state().pairs[pairKey]
    return entry && this.now() - entry.at < STEWARD_PAIR_KEEP_MS ? entry.value : undefined
  }

  /** Spends one read of today's budget; false (nothing spent) when it is used up. */
  spendPairRead(budget: number): boolean {
    const data = this.state()
    const day = stewardOrganizeDay(this.now())
    if (data.pairReads.day !== day) {
      data.pairReads = { day, count: 0 }
    }
    if (data.pairReads.count >= budget) {
      return false
    }
    data.pairReads.count += 1
    this.persist()
    return true
  }

  notePair(pairKey: string, value: number | null): void {
    this.state().pairs[pairKey] = { value, at: this.now() }
    this.persist()
  }

  goal(key: string): StewardGoalMemory | undefined {
    return this.state().goals[key]
  }

  noteGoal(key: string, goal: Omit<StewardGoalMemory, 'at'>): void {
    this.state().goals[key] = { ...goal, at: this.now() }
    this.persist()
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private state(): OrganizeStateFile {
    if (!this.loaded) {
      this.loaded = true
      this.data = this.read()
    }
    return this.data
  }

  private read(): OrganizeStateFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<OrganizeStateFile>
      const pairReads = raw.pairReads
      return {
        version: 1,
        readings: record(raw.readings),
        moves: record(raw.moves),
        pairs: record(raw.pairs),
        goals: record(raw.goals),
        pairReads:
          pairReads && typeof pairReads.day === 'string' && typeof pairReads.count === 'number'
            ? pairReads
            : { day: '', count: 0 }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[session-steward] ${this.path} is unreadable; starting empty`, error)
      }
      return empty()
    }
  }

  private persist(): void {
    const data = this.state()
    const now = this.now()
    for (const [key, at] of Object.entries(data.moves)) {
      if (now - at >= STEWARD_READING_KEEP_MS) {
        delete data.moves[key]
      }
    }
    for (const [key, entry] of Object.entries(data.pairs)) {
      if (now - entry.at >= STEWARD_PAIR_KEEP_MS) {
        delete data.pairs[key]
      }
    }
    for (const [key, goal] of Object.entries(data.goals)) {
      if (now - goal.at >= GOAL_KEEP_MS) {
        delete data.goals[key]
      }
    }
    for (const [key, list] of Object.entries(data.readings)) {
      const kept = list.filter((entry) => now - entry.at < STEWARD_READING_KEEP_MS)
      if (kept.length === 0) {
        delete data.readings[key]
      } else {
        data.readings[key] = kept
      }
    }
    const payload = JSON.stringify(data)
    const path = this.path
    this.writes = this.writes
      .then(async () => {
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(path), path, payload)
      })
      .catch((error: unknown) => {
        console.error(`[session-steward] saving ${path} failed`, error)
      })
  }
}
