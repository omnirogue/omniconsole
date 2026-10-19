import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeAutomaticSessionCleanupProtection } from '../../shared/automatic-session-cleanup-protection'
import { getEffectiveReviewWaitLiveMinutes } from '../../shared/artifact-review-sleep'

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

export function sanitizeRendererSettingsUpdate(
  args: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  if (
    'autoContinueInterruptedSessions' in sanitizedArgs &&
    typeof sanitizedArgs.autoContinueInterruptedSessions !== 'boolean'
  ) {
    delete sanitizedArgs.autoContinueInterruptedSessions
  }
  if (
    'archiveSleepsIdleAgents' in sanitizedArgs &&
    typeof sanitizedArgs.archiveSleepsIdleAgents !== 'boolean'
  ) {
    delete sanitizedArgs.archiveSleepsIdleAgents
  }
  if ('reviewWaitLiveMinutes' in sanitizedArgs) {
    sanitizedArgs.reviewWaitLiveMinutes = getEffectiveReviewWaitLiveMinutes(
      sanitizedArgs.reviewWaitLiveMinutes
    )
  }
  if ('automaticSessionCleanupProtection' in sanitizedArgs) {
    sanitizedArgs.automaticSessionCleanupProtection = normalizeAutomaticSessionCleanupProtection(
      sanitizedArgs.automaticSessionCleanupProtection
    )
  }
  // Plugin consent and enablement are main-owned authority state. Renderer
  // writes must pass the dedicated reviewed-fingerprint handlers.
  delete sanitizedArgs.experimentalOmnisiTeam
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  return sanitizedArgs
}
