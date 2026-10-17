/**
 * Main's reading of this computer's execution-host switches: `GlobalSettings.sessionHostControl`
 * (all on by default) under `OMNI_SESSION_HOST_DISABLED=1`. The steward's own switches and
 * `OMNI_STEWARD_DISABLED` still gate every unattended action through `assertUnattendedPolicy`.
 */

import {
  normalizeSessionHostControlSettings,
  SESSION_HOST_CONTROL_DISABLED_ENV,
  sessionHostControlDisabledByEnv,
  type SessionHostControlSettings
} from '../../shared/session-host-control-settings'
import { stewardDisabledByEnv, stewardSettings } from '../session-steward/steward-switches'

type SwitchSource = {
  readSettings: () => unknown
  environment: Readonly<Record<string, string | undefined>>
}

let source: SwitchSource = { readSettings: () => undefined, environment: process.env }

/** Called once at startup with the settings store; until then the defaults (all on) apply. */
export function configureSessionHostSwitches(next: Partial<SwitchSource>): () => void {
  const previous = source
  source = { ...source, ...next }
  return () => {
    source = previous
  }
}

export function sessionHostControlSettings(): SessionHostControlSettings {
  let raw: unknown
  try {
    raw = source.readSettings()
  } catch {
    raw = undefined
  }
  return normalizeSessionHostControlSettings(raw)
}

export function sessionHostDisabledByEnv(): boolean {
  return sessionHostControlDisabledByEnv(source.environment)
}

/** Other computers may control this host's sessions (its owner capability is advertised). */
export function remoteControlsOn(): boolean {
  return !sessionHostDisabledByEnv() && sessionHostControlSettings().remoteControls
}

/** Why no automatic caller may act on a session in this folder now; null when one may. */
export function hostAutomationRefusal(folderId: string | null): string | null {
  if (sessionHostDisabledByEnv()) {
    return `Automatic actions are stopped on this computer (${SESSION_HOST_CONTROL_DISABLED_ENV}). Nothing changed.`
  }
  const settings = sessionHostControlSettings()
  if (!settings.hostStewardship) {
    return 'This computer does not take automatic actions on its sessions (host stewardship is off in Settings). Nothing changed.'
  }
  if (stewardDisabledByEnv() || !stewardSettings().enabled) {
    return 'The session steward is off on this computer, so no automatic action runs here. Nothing changed.'
  }
  if (folderId && settings.folderPolicies[folderId]?.automation === 'off') {
    return 'Its folder admits no automatic actions (a folder override). Nothing changed.'
  }
  return null
}
