import type { GlobalSettings } from '../../shared/global-settings-types'
import { SETTINGS_CHANGED_WHITELIST, type SettingsChangedKey } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

const SETTINGS_CHANGED_WHITELIST_SET = new Set<string>(SETTINGS_CHANGED_WHITELIST)

// The telemetry schema accepts booleans only; raw setting values stay local.
export function trackSettingsChanges(
  updates: Partial<GlobalSettings>,
  before: GlobalSettings,
  result: GlobalSettings
): void {
  for (const key of Object.keys(updates)) {
    if (!SETTINGS_CHANGED_WHITELIST_SET.has(key)) {
      continue
    }
    const beforeValue = (before as Record<string, unknown>)[key]
    const afterValue = (result as Record<string, unknown>)[key]
    if (beforeValue === afterValue) {
      continue
    }
    if (typeof afterValue !== 'boolean') {
      // No non-bool whitelist entries today; skip rather than guess.
      continue
    }
    track('settings_changed', {
      setting_key: key as SettingsChangedKey,
      value_kind: 'bool'
    })
  }
}
