/**
 * Main's reading of the steward's switches: `GlobalSettings.sessionSteward` (all on by default)
 * under the global stop `OMNI_STEWARD_DISABLED=1`. Every steward path asks here before acting.
 */

import {
  normalizeSessionStewardSettings,
  sessionStewardDisabledByEnv,
  sessionStewardMode,
  type SessionStewardActMode,
  type SessionStewardFeature,
  type SessionStewardSettings
} from '../../shared/session-steward-settings'
import {
  stewardOrganizeModeOf,
  type StewardGuardedFeature,
  type StewardOrganizeFeature,
  type StewardOrganizeMode
} from '../../shared/session-steward-organize-settings'

type StewardSwitchSource = {
  readSettings: () => unknown
  /** Saves the whole `sessionSteward` object; only the accuracy guard and Resume write. */
  writeSettings?: (next: SessionStewardSettings) => void
  environment: Readonly<Record<string, string | undefined>>
}

let source: StewardSwitchSource = { readSettings: () => undefined, environment: process.env }

/** Called once at startup with the settings store; until then the defaults (all on) apply. */
export function configureStewardSwitches(next: Partial<StewardSwitchSource>): () => void {
  const previous = source
  source = { ...source, ...next }
  return () => {
    source = previous
  }
}

export function stewardSettings(): SessionStewardSettings {
  let raw: unknown
  try {
    raw = source.readSettings()
  } catch {
    raw = undefined
  }
  return normalizeSessionStewardSettings(raw)
}

export function stewardDisabledByEnv(): boolean {
  return sessionStewardDisabledByEnv(source.environment)
}

/** `on`, `shadow` (record only) or `off`; the env stop and `enabled` override every feature. */
export function stewardFeatureMode(feature: SessionStewardFeature): SessionStewardActMode {
  return sessionStewardMode(stewardSettings(), feature, stewardDisabledByEnv())
}

export function stewardFeatureOn(feature: SessionStewardFeature): boolean {
  return stewardFeatureMode(feature) === 'on'
}

/** Same reading as the JEV trial workflow: set and not `0`/`false`. */
export function jevDecisionsDisabledByEnv(): boolean {
  const raw = source.environment.JEV_DECISIONS_DISABLED?.trim().toLowerCase()
  return Boolean(raw) && raw !== '0' && raw !== 'false'
}

/** `on`, `off` or `paused` (accuracy guard); off under every steward stop and the JEV stop. */
export function stewardOrganizeMode(feature: StewardOrganizeFeature): StewardOrganizeMode {
  const settings = stewardSettings()
  const stopped = stewardDisabledByEnv() || !settings.enabled || jevDecisionsDisabledByEnv()
  return stewardOrganizeModeOf(settings.organize, feature, stopped)
}

/** The saved mode, whatever the global stops say (the guard pauses only what is `on` here). */
export function savedStewardOrganizeMode(feature: StewardGuardedFeature): StewardOrganizeMode {
  return stewardSettings().organize[feature]
}

/** Writes one organizing mode; false when no settings writer is configured. */
export function setStewardOrganizeMode(
  feature: StewardGuardedFeature,
  mode: StewardOrganizeMode
): boolean {
  if (!source.writeSettings) {
    return false
  }
  const current = stewardSettings()
  source.writeSettings({ ...current, organize: { ...current.organize, [feature]: mode } })
  return true
}
