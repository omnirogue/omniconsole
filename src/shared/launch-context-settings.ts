import type { GlobalSettings } from './global-settings-types'
import { normalizeAgentTemplateSettings } from './agent-templates'
import { normalizeLaunchContextMemory } from './local-ollama-launch'

/** The launcher's two settings keys, normalized together wherever a settings update is sanitized. */
export function normalizeLaunchContextSettingsUpdate(
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const sanitized: Partial<GlobalSettings> = {}
  if ('agentTemplates' in updates) {
    sanitized.agentTemplates = normalizeAgentTemplateSettings(updates.agentTemplates)
  }
  if ('launchContextMemory' in updates) {
    sanitized.launchContextMemory = normalizeLaunchContextMemory(updates.launchContextMemory)
  }
  return sanitized
}
