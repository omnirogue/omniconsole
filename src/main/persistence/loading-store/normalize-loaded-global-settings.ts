import { getDefaultVoiceSettings } from '../../../shared/constants'
import { normalizeCustomModelPresets } from '../../../shared/custom-model-presets'
import { normalizeAgentTemplateSettings } from '../../../shared/agent-templates'
import { normalizeLaunchContextMemory } from '../../../shared/local-ollama-launch'
import { normalizePRBotAuthorOverrides } from '../../../shared/pr-bot-author-overrides'
import { normalizeTerminalQuickCommands } from '../../../shared/terminal-quick-commands'
import { normalizeOpenInApplications } from '../../../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../../../shared/keybindings'
import { normalizeAppIconId } from '../../../shared/app-icon'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { projectSourceControlAiToLegacyCommitMessageAi } from '../../../shared/source-control-ai'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { normalizeNextStepSuggestionSettings } from '../../../shared/next-step-suggestion-settings'
import { normalizeSessionStewardSettings } from '../../../shared/session-steward-settings'
import { normalizeSessionHostControlSettings } from '../../../shared/session-host-control-settings'
import { stripRetiredGlobalSettings } from '../applying-settings/terminal-settings-migrations'
import { readLegacySidekickFlag } from '../applying-settings/onboarding-normalization'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PreparedLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import type { PreparedLoadedProfileSettings } from './prepare-loaded-profile-settings'

export function normalizeLoadedGlobalSettings(
  parsed: PersistedState,
  terminal: PreparedLoadedTerminalSettings,
  profile: PreparedLoadedProfileSettings
): PersistedState['settings'] {
  const {
    defaults,
    migratedExternalVisibility,
    migratedTerminalScrollback,
    migratedTerminalTuiScrollSensitivity,
    migratedSourceControlAi,
    migratedOptionAsAlt,
    migratedFloatingTerminalEnabled,
    migratedOsc52Clipboard,
    migratedFloatingTerminalCwd,
    migratedFloatingTerminalTrustedCwds
  } = terminal
  const {
    migratedExperimentalActivity,
    migratedAutoRenameBranchFromWork,
    migratedTerminalCursorStyle,
    migratedTerminalLineHeight,
    terminalRightClickToPasteDefaultedForPlatform,
    taskProviderSettings,
    taskSourcesMode,
    taskSourcesModeChosen,
    primarySelectionDefaultedForLinux,
    primarySelectionDefaultedForTerminalDefaults,
    migratePrimarySelectionPlatformDefault,
    stampPrimarySelectionTerminalDefaults,
    migratedDisabledTuiAgents,
    migratedAgentYoloDefaults,
    migratedWindowsRuntimeDefault,
    migratedLocalAccountRuntime,
    loadedCompactWorktreeCards,
    mobilePairingCustomAddress,
    mobilePairingCustomAddresses,
    normalizedNotifications,
    normalizedSourceControlGroupOrder
  } = profile

  return {
    ...defaults.settings,
    // Why (#7977): v1.4.130 onboarding persisted this as a plain boolean, making the
    // old default indistinguishable from a real opt-in. Preserve stored `true`; only
    // the default changed.
    ...stripRetiredGlobalSettings(parsed.settings),
    customModelPresets: normalizeCustomModelPresets(parsed.settings?.customModelPresets),
    agentTemplates: normalizeAgentTemplateSettings(parsed.settings?.agentTemplates),
    launchContextMemory: normalizeLaunchContextMemory(parsed.settings?.launchContextMemory),
    worktreeVisibilityDefaults: migratedExternalVisibility.defaults,
    prBotAuthorOverrides: normalizePRBotAuthorOverrides(parsed.settings?.prBotAuthorOverrides),
    // Why: v1.3.42 renamed the sidekick setting to pet; carry the old flag forward once so enabled users don't lose it.
    experimentalPet: parsed.settings?.experimentalPet ?? readLegacySidekickFlag(parsed) ?? false,
    // Why: early builds saved the disabled default; flip Linux/macOS profiles once to match platform, guards keep opt-outs.
    primarySelectionMiddleClickPaste: migratePrimarySelectionPlatformDefault
      ? true
      : (parsed.settings?.primarySelectionMiddleClickPaste ??
        defaults.settings.primarySelectionMiddleClickPaste),
    primarySelectionMiddleClickPasteDefaultedForLinux:
      primarySelectionDefaultedForLinux ||
      (process.platform === 'linux' && migratePrimarySelectionPlatformDefault),
    primarySelectionMiddleClickPasteDefaultedForTerminalDefaults:
      primarySelectionDefaultedForTerminalDefaults || stampPrimarySelectionTerminalDefaults,
    ...migratedAutoRenameBranchFromWork,
    ...migratedTerminalCursorStyle,
    terminalLineHeight: migratedTerminalLineHeight,
    // Why: the old true default was inherited, but false was always an explicit opt-out and must survive this one-shot reset.
    terminalRightClickToPaste: terminalRightClickToPasteDefaultedForPlatform
      ? (parsed.settings?.terminalRightClickToPaste ?? defaults.settings.terminalRightClickToPaste)
      : parsed.settings?.terminalRightClickToPaste === false
        ? false
        : defaults.settings.terminalRightClickToPaste,
    terminalRightClickToPasteDefaultedForPlatform: true,
    ...migratedTerminalTuiScrollSensitivity.settings,
    experimentalActivity: migratedExperimentalActivity,
    experimentalActivityDefaultedOffForAllUsers: true,
    // Why: compact worktree cards graduated from Experimental; preserve the old opt-in for rollout-era profiles.
    compactWorktreeCards: loadedCompactWorktreeCards,
    experimentalCompactWorktreeCards: undefined,
    terminalMacOptionAsAlt: migratedOptionAsAlt,
    terminalMacOptionAsAltMigrated: true,
    localWindowsRuntimeDefault: migratedWindowsRuntimeDefault,
    localAccountRuntime: migratedLocalAccountRuntime,
    localAccountRuntimeDefaultedToAutoForAllUsers: true,
    ...migratedOsc52Clipboard,
    floatingTerminalEnabled: migratedFloatingTerminalEnabled,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: migratedFloatingTerminalCwd,
    floatingTerminalTrustedCwds: migratedFloatingTerminalTrustedCwds,
    floatingTerminalCwdMigratedToAppWorkspace: true,
    terminalScrollbackRows: migratedTerminalScrollback.rows,
    terminalQuickCommands: normalizeTerminalQuickCommands(parsed.settings?.terminalQuickCommands),
    terminalCustomThemes: normalizeTerminalCustomThemes(parsed.settings?.terminalCustomThemes),
    appIcon: normalizeAppIconId(parsed.settings?.appIcon),
    mobilePairingCustomAddress,
    mobilePairingCustomAddresses,
    // Why: persisted settings may be hand-edited or from older builds; keep tray-minimize false unless stored value is true.
    minimizeToTrayOnClose: parsed.settings?.minimizeToTrayOnClose === true,
    // Why: missing means default-on; round-trips unchanged on non-mac since darwin consumers gate the effect.
    showMenuBarIcon: parsed.settings?.showMenuBarIcon !== false,
    uiLanguage: normalizeUiLanguage(parsed.settings?.uiLanguage),
    defaultTaskSource: taskProviderSettings.defaultTaskSource,
    visibleTaskProviders: taskProviderSettings.visibleTaskProviders,
    visibleTaskProvidersDefaultedForJira: true,
    visibleTaskProvidersDefaultedForBackoffice: true,
    taskSourcesMode,
    taskSourcesModeChosen,
    terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
      parsed.settings?.terminalShortcutPolicy
    ),
    disabledTuiAgents: migratedDisabledTuiAgents,
    ...migratedAgentYoloDefaults,
    claudeAgentTeamsDefaultDisabledMigrated: true,
    openInApplications: normalizeOpenInApplications(parsed.settings?.openInApplications, {
      seedDefaults: true
    }),
    notifications: normalizedNotifications,
    sourceControlAi: migratedSourceControlAi,
    sourceControlGroupOrder: normalizedSourceControlGroupOrder,
    // Why: rollback builds still read commitMessageAi, so refresh the legacy projection from sourceControlAi for compat.
    commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(
      migratedSourceControlAi,
      parsed.settings?.commitMessageAi ?? defaults.settings.commitMessageAi
    ),
    voice: {
      ...getDefaultVoiceSettings(),
      ...parsed.settings?.voice
    },
    nextStepSuggestions: normalizeNextStepSuggestionSettings(parsed.settings?.nextStepSuggestions),
    automaticOutcomeDispatch: parsed.settings?.automaticOutcomeDispatch !== false,
    dispatchRoutingMode:
      parsed.settings?.dispatchRoutingMode === 'off' ||
      parsed.settings?.dispatchRoutingMode === 'shadow'
        ? parsed.settings.dispatchRoutingMode
        : 'live',
    sessionSteward: normalizeSessionStewardSettings(parsed.settings?.sessionSteward),
    sessionHostControl: normalizeSessionHostControlSettings(parsed.settings?.sessionHostControl)
  }
}
