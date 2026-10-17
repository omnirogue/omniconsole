/**
 * The steward's organizing switches (Phase 3), under `GlobalSettings.sessionSteward.organize`.
 * Sal: every feature ships on. Re-filing and re-titling also read `paused`, which only the
 * accuracy guard writes; one click in Work (or the switch in Settings) sets them back to `on`.
 */

export const STEWARD_ORGANIZE_MODES = ['on', 'off', 'paused'] as const
export type StewardOrganizeMode = (typeof STEWARD_ORGANIZE_MODES)[number]

/** The features the accuracy guard watches and may pause. */
export const STEWARD_GUARDED_FEATURES = ['refile', 'retitle'] as const
export type StewardGuardedFeature = (typeof STEWARD_GUARDED_FEATURES)[number]

export type StewardOrganizeFeature =
  | StewardGuardedFeature
  | 'mergeSuggestions'
  | 'projectSuggestions'

export type StewardAccuracyGuardSettings = {
  /** Rolling window of the steward's own changes that are counted. */
  windowDays: number
  /** Fewer changes than this never pause a feature. */
  minSamples: number
  /** Share of changes a person may undo before the feature pauses (rounded in its favour). */
  maxCorrectionRate: number
}

export type SessionStewardOrganizeSettings = {
  /** Move idle sessions the steward filed (or nobody filed) to a better folder. */
  refile: StewardOrganizeMode
  /** Re-title a session whose goal moved on, never a title the person typed. */
  retitle: StewardOrganizeMode
  /** Suggest merging two sessions doing the same work (Yes happens in Work). */
  mergeSuggestions: boolean
  /** Suggest making a busy batch folder a Saved project. */
  projectSuggestions: boolean
  accuracyGuard: StewardAccuracyGuardSettings
  /** JEV pair questions (merge and project reads) per day. */
  pairReadsPerDay: number
}

export function getDefaultStewardOrganizeSettings(): SessionStewardOrganizeSettings {
  return {
    refile: 'on',
    retitle: 'on',
    mergeSuggestions: true,
    projectSuggestions: true,
    accuracyGuard: { windowDays: 14, minSamples: 5, maxCorrectionRate: 0.2 },
    pairReadsPerDay: 50
  }
}

function organizeMode(raw: unknown): StewardOrganizeMode {
  if (raw === false) {
    return 'off'
  }
  return (STEWARD_ORGANIZE_MODES as readonly unknown[]).includes(raw)
    ? (raw as StewardOrganizeMode)
    : 'on'
}

function boundedNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean
): number {
  return typeof raw === 'number' &&
    Number.isFinite(raw) &&
    (!integer || Number.isInteger(raw)) &&
    raw >= min &&
    raw <= max
    ? raw
    : fallback
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** Persisted or hand-edited input: each feature is on unless explicitly off (or paused). */
export function normalizeStewardOrganizeSettings(raw: unknown): SessionStewardOrganizeSettings {
  const defaults = getDefaultStewardOrganizeSettings()
  const value = record(raw)
  const guard = record(value.accuracyGuard)
  return {
    refile: organizeMode(value.refile),
    retitle: organizeMode(value.retitle),
    mergeSuggestions: value.mergeSuggestions !== false,
    projectSuggestions: value.projectSuggestions !== false,
    accuracyGuard: {
      windowDays: boundedNumber(guard.windowDays, defaults.accuracyGuard.windowDays, 1, 90, true),
      minSamples: boundedNumber(guard.minSamples, defaults.accuracyGuard.minSamples, 1, 1000, true),
      maxCorrectionRate: boundedNumber(
        guard.maxCorrectionRate,
        defaults.accuracyGuard.maxCorrectionRate,
        0,
        1,
        false
      )
    },
    pairReadsPerDay: boundedNumber(value.pairReadsPerDay, defaults.pairReadsPerDay, 0, 1000, true)
  }
}

/**
 * What one organizing feature does now. The steward's global stops (env, `enabled`) and
 * `JEV_DECISIONS_DISABLED` (every organizing step is a JEV reading) turn it off.
 */
export function stewardOrganizeModeOf(
  organize: SessionStewardOrganizeSettings,
  feature: StewardOrganizeFeature,
  stopped: boolean
): StewardOrganizeMode {
  if (stopped) {
    return 'off'
  }
  const value = organize[feature]
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : value
}
