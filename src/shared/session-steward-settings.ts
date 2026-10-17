/**
 * The session steward's switches (Phase 2). Sal, 25 Sep: every feature ships on; each switch is
 * an emergency off, and `OMNI_STEWARD_DISABLED=1` in main's environment stops them all at once.
 */

import {
  getDefaultStewardOrganizeSettings,
  normalizeStewardOrganizeSettings,
  type SessionStewardOrganizeSettings
} from './session-steward-organize-settings'

/** `shadow` records what the steward would do and does nothing; diagnostics only, never a default. */
export const SESSION_STEWARD_ACT_MODES = ['on', 'shadow', 'off'] as const
export type SessionStewardActMode = (typeof SESSION_STEWARD_ACT_MODES)[number]

export const SESSION_STEWARD_EMPTY_ACTIONS = ['close', 'archive'] as const
export type SessionStewardEmptyAction = (typeof SESSION_STEWARD_EMPTY_ACTIONS)[number]

export type SessionStewardSettings = {
  /** Off stops every steward path, whatever the switches below say. */
  enabled: boolean
  /** Press Yes on a safe next step inside the original request (D4). */
  safeYes: SessionStewardActMode
  /** Nudge an idle session with work left; ask an unclear one whether it is done. */
  nudges: boolean
  /** Archive a finished session after the clock-menu Done delay, with a result card (D3 Tier 2). */
  tier2Archive: SessionStewardActMode
  /** Start a one-off cleanup session when leftovers pile up (D7). */
  automaticCleanup: boolean
  /** A session may wait for another session's result. */
  sessionWaits: boolean
  /** Automatic archive keeps a session another one waits on. */
  tier1WaiterCheck: boolean
  /** Clean up a session an agent started that no person ever prompted (`emptySessionAction`). */
  emptySessionArchive: boolean
  /** `close` ends its agent through the sidebar's Delete; `archive` only hides the row. */
  emptySessionAction: SessionStewardEmptyAction
  /**
   * Idle minutes before a blank session is cleaned up. Renamed from `emptySessionMinutes` (Sal,
   * 27 Sep): the old key's 30 was only its first default, so a stored value is not carried over.
   */
  emptySessionCloseMinutes: number
  /** Leftovers that start an automatic cleanup. */
  pileupThreshold: number
  /** Phase 3: re-filing, re-titling and suggestions (session-steward-organize-settings.ts). */
  organize: SessionStewardOrganizeSettings
}

/** A switch the steward's code asks about (`enabled` gates them all). */
export type SessionStewardFeature = Exclude<
  keyof SessionStewardSettings,
  'pileupThreshold' | 'organize' | 'emptySessionCloseMinutes' | 'emptySessionAction'
>

export const SESSION_STEWARD_SWITCHES = [
  'enabled',
  'safeYes',
  'nudges',
  'tier2Archive',
  'automaticCleanup',
  'sessionWaits',
  'tier1WaiterCheck',
  'emptySessionArchive'
] as const satisfies readonly SessionStewardFeature[]

export const SESSION_STEWARD_DISABLED_ENV = 'OMNI_STEWARD_DISABLED'
export const SESSION_STEWARD_PILEUP_THRESHOLD_DEFAULT = 8
const PILEUP_THRESHOLD_MAX = 1000
export const SESSION_STEWARD_EMPTY_SESSION_MINUTES_DEFAULT = 2
export const SESSION_STEWARD_EMPTY_SESSION_MINUTES_MIN = 1
export const SESSION_STEWARD_EMPTY_SESSION_MINUTES_MAX = 24 * 60

export function getDefaultSessionStewardSettings(): SessionStewardSettings {
  return {
    enabled: true,
    safeYes: 'on',
    nudges: true,
    tier2Archive: 'on',
    automaticCleanup: true,
    sessionWaits: true,
    tier1WaiterCheck: true,
    emptySessionArchive: true,
    emptySessionAction: 'close',
    emptySessionCloseMinutes: SESSION_STEWARD_EMPTY_SESSION_MINUTES_DEFAULT,
    pileupThreshold: SESSION_STEWARD_PILEUP_THRESHOLD_DEFAULT,
    organize: getDefaultStewardOrganizeSettings()
  }
}

function actMode(raw: unknown): SessionStewardActMode {
  if (raw === false) {
    return 'off'
  }
  return (SESSION_STEWARD_ACT_MODES as readonly unknown[]).includes(raw)
    ? (raw as SessionStewardActMode)
    : 'on'
}

/** Persisted or hand-edited input: each switch is on unless explicitly off. */
export function normalizeSessionStewardSettings(raw: unknown): SessionStewardSettings {
  const defaults = getDefaultSessionStewardSettings()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults
  }
  const value = raw as Record<string, unknown>
  const threshold = value.pileupThreshold
  const emptyMinutes = value.emptySessionCloseMinutes
  return {
    enabled: value.enabled !== false,
    safeYes: actMode(value.safeYes),
    nudges: value.nudges !== false,
    tier2Archive: actMode(value.tier2Archive),
    automaticCleanup: value.automaticCleanup !== false,
    sessionWaits: value.sessionWaits !== false,
    tier1WaiterCheck: value.tier1WaiterCheck !== false,
    emptySessionArchive: value.emptySessionArchive !== false,
    emptySessionAction: value.emptySessionAction === 'archive' ? 'archive' : 'close',
    emptySessionCloseMinutes:
      typeof emptyMinutes === 'number' &&
      Number.isInteger(emptyMinutes) &&
      emptyMinutes >= SESSION_STEWARD_EMPTY_SESSION_MINUTES_MIN &&
      emptyMinutes <= SESSION_STEWARD_EMPTY_SESSION_MINUTES_MAX
        ? emptyMinutes
        : defaults.emptySessionCloseMinutes,
    pileupThreshold:
      typeof threshold === 'number' &&
      Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= PILEUP_THRESHOLD_MAX
        ? threshold
        : defaults.pileupThreshold,
    organize: normalizeStewardOrganizeSettings(value.organize)
  }
}

/** Same reading as `JEV_DECISIONS_DISABLED`: set and not `0`/`false`. */
export function sessionStewardDisabledByEnv(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const raw = env[SESSION_STEWARD_DISABLED_ENV]?.trim().toLowerCase()
  return Boolean(raw) && raw !== '0' && raw !== 'false'
}

/** What one switch does now: the env stop and `enabled` override every feature. */
export function sessionStewardMode(
  settings: SessionStewardSettings,
  feature: SessionStewardFeature,
  disabledByEnv: boolean
): SessionStewardActMode {
  if (disabledByEnv || !settings.enabled) {
    return 'off'
  }
  const value = settings[feature]
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : value
}
