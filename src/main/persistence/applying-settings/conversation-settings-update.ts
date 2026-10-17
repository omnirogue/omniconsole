import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeConversationLaunchDefaults } from '../../../shared/conversation-launch-defaults'
import { normalizeAttentionLaunchFavorites } from '../../../shared/attention-launch-favorites'
import { normalizeCustomModelPresets } from '../../../shared/custom-model-presets'
import { normalizeLaunchContextSettingsUpdate } from '../../../shared/launch-context-settings'
import { normalizePrimaryAiPreference } from '../../../shared/omnirogue-account'
import { normalizeSavedReviewRubrics } from '../../../shared/review-rubrics'
import {
  normalizeSessionActionPresetSettings,
  normalizeSessionActionPresetsByWorkspace
} from '../../../shared/session-action-presets'

export function normalizeConversationSettingsUpdate(
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const sanitizedUpdates: Partial<GlobalSettings> = {}
  if ('customModelPresets' in updates) {
    sanitizedUpdates.customModelPresets = normalizeCustomModelPresets(updates.customModelPresets)
  }
  Object.assign(sanitizedUpdates, normalizeLaunchContextSettingsUpdate(updates))
  if ('conversationLaunchDefaults' in updates) {
    sanitizedUpdates.conversationLaunchDefaults = normalizeConversationLaunchDefaults(
      updates.conversationLaunchDefaults
    )
  }
  if ('attentionLaunchFavorites' in updates) {
    sanitizedUpdates.attentionLaunchFavorites = normalizeAttentionLaunchFavorites(
      updates.attentionLaunchFavorites
    )
  }
  if ('primaryAi' in updates) {
    sanitizedUpdates.primaryAi = normalizePrimaryAiPreference(updates.primaryAi)
  }
  if ('reviewRubrics' in updates) {
    sanitizedUpdates.reviewRubrics = normalizeSavedReviewRubrics(updates.reviewRubrics)
  }
  if ('sessionActionPresets' in updates) {
    sanitizedUpdates.sessionActionPresets = normalizeSessionActionPresetSettings(
      updates.sessionActionPresets
    )
  }
  if ('sessionActionPresetsByWorkspace' in updates) {
    sanitizedUpdates.sessionActionPresetsByWorkspace = normalizeSessionActionPresetsByWorkspace(
      updates.sessionActionPresetsByWorkspace
    )
  }
  return sanitizedUpdates
}
