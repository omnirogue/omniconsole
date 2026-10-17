/**
 * The accuracy guard (Phase 3): re-filing and re-titling ship on and pause themselves on
 * evidence. Each steward change is a sample; it counts as corrected when an Undo names it or a
 * person changes the same field within 24 hours. With enough samples in the rolling window and
 * too many corrected, the feature is set to `paused` until the person resumes it.
 * `<userData>/session-steward/accuracy-guard.json`; docs/reference/session-steward.md.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isStewardExecutor,
  organizationTargetKey,
  revisionFieldOf,
  type OrganizationChangeKind,
  type OrganizationRecord
} from '../../../shared/session-organization-change'
import {
  STEWARD_GUARDED_FEATURES,
  type StewardAccuracyGuardSettings,
  type StewardGuardedFeature,
  type StewardOrganizeMode
} from '../../../shared/session-steward-organize-settings'
import type { StewardGuardNotice } from '../../../shared/session-steward-suggestions'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'
import type { OrganizationHistoryStore } from '../../session-organization/organization-history-store'
import { sessionOrganizationLedgerFor } from '../../session-organization/organization-change-ledger'
import { setStewardOrganizeMode, stewardOrganizeMode, stewardSettings } from '../steward-switches'
import { STEWARD_DIRECTORY } from './steward-suggestions-store'

export const STEWARD_ACCURACY_GUARD_FILE = 'accuracy-guard.json'
const DAY_MS = 24 * 60 * 60 * 1000
/** A person's own change to the same field this soon after the steward's reads as a correction. */
export const STEWARD_CORRECTION_WINDOW_MS = DAY_MS
const KEEP_MS = 90 * DAY_MS
const MAX_SAMPLES = 1000

const KIND_OF: Record<StewardGuardedFeature, OrganizationChangeKind> = {
  refile: 'move',
  retitle: 'title'
}

type GuardSample = { opId: string; ts: string; kind: OrganizationChangeKind; keys: string[] }

type GuardFeatureState = {
  samples: GuardSample[]
  /** Only samples from this time count (a resume starts a fresh sample). */
  resumedAt?: number
  paused?: { at: number; corrected: number; samples: number; written: boolean }
}

type GuardFile = { version: 1; features: Partial<Record<StewardGuardedFeature, GuardFeatureState>> }

export type StewardGuardSwitches = {
  /** What the feature does now, every steward stop included (`stewardOrganizeMode`). */
  mode: (feature: StewardGuardedFeature) => StewardOrganizeMode
  /** Saves the setting; false when it could not be written. */
  write: (feature: StewardGuardedFeature, mode: StewardOrganizeMode) => boolean
  settings: () => StewardAccuracyGuardSettings
}

export type StewardGuardState = {
  mode: StewardOrganizeMode
  samples: number
  corrected: number
  /** Set while the guard holds the feature paused. */
  paused?: StewardGuardNotice
}

/** Too many corrected: over the rate, rounded in the steward's favour (2 of 8 stays on, 3 pauses). */
export function stewardGuardTrips(
  corrected: number,
  samples: number,
  settings: StewardAccuracyGuardSettings
): boolean {
  return (
    samples >= settings.minSamples &&
    corrected > Math.ceil(samples * settings.maxCorrectionRate - 1e-9)
  )
}

export class StewardAccuracyGuard {
  private features: Partial<Record<StewardGuardedFeature, GuardFeatureState>> = {}
  private loaded = false
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      /** `<userData>/session-steward`. */
      directory: string
      history: Pick<OrganizationHistoryStore, 'entriesFor'>
      switches: StewardGuardSwitches
      now?: () => number
    }
  ) {}

  get path(): string {
    return join(this.options.directory, STEWARD_ACCURACY_GUARD_FILE)
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * One applied steward change of this feature (re-file: a move, re-title: a title). Changes the
   * person accepted in Work carry a request and are not samples. False when it was not counted.
   */
  record(feature: StewardGuardedFeature, record: OrganizationRecord): boolean {
    const state = this.stateOf(feature)
    if (
      record.phase !== 'applied' ||
      !isStewardExecutor(record.executor) ||
      record.kind !== KIND_OF[feature] ||
      record.request ||
      state.samples.some((sample) => sample.opId === record.opId)
    ) {
      return false
    }
    const keys = record.targets
      .map(organizationTargetKey)
      .filter((key): key is string => key !== null)
    state.samples.push({ opId: record.opId, ts: record.ts, kind: record.kind, keys })
    this.persist()
    return true
  }

  /** The feature's mode after checking the evidence; pauses it here when it trips. */
  state(feature: StewardGuardedFeature): StewardGuardState {
    const state = this.stateOf(feature)
    const current = this.options.switches.mode(feature)
    // Why: the Settings switch set back to on is a resume too, with a fresh sample.
    if (state.paused?.written && current === 'on') {
      this.clearPause(state)
    }
    const counts = this.count(feature)
    if (state.paused) {
      return {
        mode: current === 'off' ? 'off' : 'paused',
        ...counts,
        paused: this.notice(feature, state.paused)
      }
    }
    if (current === 'paused') {
      // Saved as paused with no record of why (a lost file): still offer Resume.
      return {
        mode: 'paused',
        ...counts,
        paused: this.notice(feature, { at: this.now(), ...counts })
      }
    }
    if (current === 'on' && stewardGuardTrips(counts.corrected, counts.samples, this.settings())) {
      let written = false
      try {
        written = this.options.switches.write(feature, 'paused')
      } catch (error) {
        console.warn(`[session-steward] pausing ${feature} in Settings failed`, error)
      }
      state.paused = { at: this.now(), ...counts, written }
      this.persist()
      return { mode: 'paused', ...counts, paused: this.notice(feature, state.paused) }
    }
    return { mode: current, ...counts }
  }

  /** Paused features with the evidence they paused on (the Work card's notices). */
  notices(): StewardGuardNotice[] {
    // Why mode too: under a steward stop Resume would change nothing, so no notice offers it.
    return STEWARD_GUARDED_FEATURES.map((feature) => this.state(feature))
      .filter((state) => state.mode === 'paused')
      .flatMap((state) => (state.paused ? [state.paused] : []))
  }

  /** The person's one click: back on, counting only changes from now. */
  resume(feature: StewardGuardedFeature): StewardGuardState {
    this.clearPause(this.stateOf(feature))
    if (!this.options.switches.write(feature, 'on')) {
      throw new Error('Settings could not be saved, so it is still paused.')
    }
    return this.state(feature)
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private settings(): StewardAccuracyGuardSettings {
    return this.options.switches.settings()
  }

  private clearPause(state: GuardFeatureState): void {
    delete state.paused
    state.resumedAt = this.now()
    this.persist()
  }

  private notice(
    feature: StewardGuardedFeature,
    paused: { at: number; corrected: number; samples: number }
  ): StewardGuardNotice {
    return { feature, corrected: paused.corrected, samples: paused.samples, pausedAt: paused.at }
  }

  /** Samples in the rolling window (since the last resume) and how many a person corrected. */
  private count(feature: StewardGuardedFeature): { samples: number; corrected: number } {
    const state = this.stateOf(feature)
    const since = Math.max(
      this.now() - this.settings().windowDays * DAY_MS,
      state.resumedAt ?? Number.NEGATIVE_INFINITY
    )
    const counted = state.samples.filter((sample) => Date.parse(sample.ts) >= since)
    return {
      samples: counted.length,
      corrected: counted.filter((sample) => this.isCorrected(sample)).length
    }
  }

  private isCorrected(sample: GuardSample): boolean {
    const at = Date.parse(sample.ts)
    const field = revisionFieldOf(sample.kind)
    return sample.keys.some((key) =>
      this.options.history.entriesFor(key).some((later) => {
        if (later.opId === sample.opId || later.phase !== 'applied') {
          return false
        }
        if (later.undoOf === sample.opId) {
          return true
        }
        const delay = Date.parse(later.ts) - at
        return (
          later.executor.kind === 'person' &&
          revisionFieldOf(later.kind) === field &&
          delay >= 0 &&
          delay <= STEWARD_CORRECTION_WINDOW_MS
        )
      })
    )
  }

  private stateOf(feature: StewardGuardedFeature): GuardFeatureState {
    this.load()
    let state = this.features[feature]
    if (!state) {
      state = { samples: [] }
      this.features[feature] = state
    }
    return state
  }

  private load(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<GuardFile>
      for (const feature of STEWARD_GUARDED_FEATURES) {
        const entry = raw.features?.[feature]
        if (entry && Array.isArray(entry.samples)) {
          this.features[feature] = {
            samples: entry.samples.filter(
              (sample) => typeof sample?.opId === 'string' && typeof sample.ts === 'string'
            ),
            ...(typeof entry.resumedAt === 'number' ? { resumedAt: entry.resumedAt } : {}),
            ...(entry.paused && typeof entry.paused.at === 'number' ? { paused: entry.paused } : {})
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[session-steward] ${this.path} is unreadable; starting empty`, error)
      }
    }
  }

  private persist(): void {
    const cutoff = this.now() - KEEP_MS
    for (const state of Object.values(this.features)) {
      state.samples = state.samples
        .filter((sample) => Date.parse(sample.ts) >= cutoff)
        .slice(-MAX_SAMPLES)
    }
    const payload = JSON.stringify({ version: 1, features: this.features } satisfies GuardFile)
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

const guards = new Map<string, StewardAccuracyGuard>()

/** One guard per profile directory, reading that profile's history and steward switches. */
export function stewardAccuracyGuardFor(userDataPath: string): StewardAccuracyGuard {
  let guard = guards.get(userDataPath)
  if (!guard) {
    guard = new StewardAccuracyGuard({
      directory: join(userDataPath, STEWARD_DIRECTORY),
      history: sessionOrganizationLedgerFor(userDataPath).store,
      switches: {
        mode: stewardOrganizeMode,
        write: setStewardOrganizeMode,
        settings: () => stewardSettings().organize.accuracyGuard
      }
    })
    guards.set(userDataPath, guard)
  }
  return guard
}
