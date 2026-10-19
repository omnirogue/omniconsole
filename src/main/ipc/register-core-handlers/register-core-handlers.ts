import { registerOmnisiTeamHandlers, setTrustedOmnisiTeamRenderer } from '../../omnisi-team/handlers'
import { registerRoutineAlertHandlers } from '../routine-alerts'
import { registerConsoleRoutineConversationHandlers } from '../console-routine-conversation'
import { registerConsoleTeamRoutinesHandlers } from '../console-team-routines'
import { app, BrowserWindow } from 'electron'

import { registerBackofficeHandlers } from '../backoffice'
import { registerConsoleWorkflowHandlers } from '../console-workflows'
import { registerWorkflowScriptHandlers } from '../workflow-script-ipc'
import { registerConsoleAdvertisingHandlers } from '../console-advertising'
import { registerConsoleCompanyHandlers } from '../console-companies'
import { registerConsoleQuickBooksHandlers } from '../console-quickbooks'
import { registerTeamMemoryHandlers, startTeamMemoryStatusPolling } from '../team-memory'
import { registerConsoleAccessHandlers } from '../console-access'
import { registerBrowserLoginsHandlers } from '../browser-logins'
import { registerConsoleDriveHandlers } from '../console-drive'
import { registerSessionLedgerHandlers } from '../session-ledger'
import { registerSessionFrameLogHandlers } from '../session-frame-log-ipc'
import { registerCompanyWorkspaceHandlers } from '../company-workspaces'
import { registerLocalOllamaHandlers } from '../local-ollama'
import { registerConsoleLocalExecutionHandlers } from '../console-local-execution'
import { startBackofficeAssignmentPoller } from '../../backoffice/backoffice-assignment-poller'
import { syncBackofficeFromSettings } from '../../backoffice/backoffice-config'
import { registerAppHandlers } from '../app'
import { registerCliHandlers } from '../cli'
import { registerPreflightHandlers } from '../preflight'
import type { Store } from '../../persistence'
import type { OrcaRuntimeService } from '../../runtime/omni-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerFilesystemHandlers } from '../filesystem'
import { registerDeliverablesHubHandlers } from '../deliverables-hub'
import { registerAssistedBriefHandlers } from '../assisted-brief'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/commit-message-agent-environment'
import { registerFilesystemWatcherHandlers } from '../filesystem-watcher'
import { registerUsageProviderHandlers } from '../usage-provider-handlers'
import { registerGitHubHandlers } from '../github'
import { registerGitLabHandlers } from '../gitlab'
import { registerHostedReviewHandlers } from '../hosted-review'
import { registerLinearHandlers } from '../linear'
import { registerJiraHandlers } from '../jira'
import { registerBitbucketHandlers } from '../bitbucket'
import { registerFeedbackHandlers } from '../feedback'
import { registerCrashReportingHandlers } from '../crash-reporting'
import { registerExportHandlers } from '../export'
import { registerStatsHandlers } from '../stats'
import { registerMemoryHandlers } from '../memory'
import { registerRateLimitHandlers } from '../rate-limits'
import { registerRuntimeHandlers } from '../runtime'
import { registerRuntimeEnvironmentHandlers } from '../runtime-environments'
import { registerEphemeralVmHandlers } from '../ephemeral-vm'
import { registerAiVaultHandlers } from '../ai-vault'
import { registerSessionSearchHandlers } from '../session-search'
import { registerNativeChatHandlers } from '../native-chat'
import { registerNotificationHandlers } from '../notifications'
import { registerNotebookHandlers } from '../notebook'
import { registerOnboardingHandlers } from '../onboarding'
import { registerOmniCreditsIpc } from '../omni-credits-ipc'
import { registerOmniRogueHandlers } from '../omnirogue'
import { registerDashboardPopoutHandlers } from '../dashboard-popout'
import { registerTerminalPreviewHandlers } from '../terminal-preview'
import { registerDeveloperPermissionHandlers } from '../developer-permissions'
import { registerComputerUsePermissionHandlers } from '../computer-use-permissions'
import { setAgentBrowserBridgeRef, registerBrowserHandlers } from '../browser'
import { setTrustedBrowserRendererWebContentsId } from '../browser-renderer-trust'
import { registerSessionHandlers } from '../session'
import { registerSettingsHandlers } from '../settings'
import { registerMcpConnectorHandlers } from '../mcp-connectors'
import { registerDiagnosticsHandlers } from '../diagnostics'
import { registerSkillsHandlers } from '../skills'
import { registerSkillDeleteIpcHandlers } from '../skill-delete/handlers'
import { registerWorkspaceSpaceHandlers } from '../workspace-space'
import { registerWorkspacePortHandlers } from '../workspace-ports'
import { registerLocalhostWorktreeLabelHandlers } from '../localhost-worktree-labels'
import { registerSessionFilePreviewHandlers } from '../session-file-previews'
import { registerAutomationHandlers } from '../automations'
import { registerKeybindingHandlers } from '../keybindings'
import { registerTelemetryHandlers } from '../telemetry'
import { registerShellHandlers } from '../shell'
import { registerPetHandlers } from '../pet'
import { registerWorkflowContextHandlers } from '../workflow-context-handlers'
import { registerPluginHandlers } from '../plugins'
import { registerUIHandlers, setTrustedUIRendererWebContentsId } from '../ui'
import { registerEmulatorFrameStreamHandlers } from '../emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator-video-stream'
import { registerSpeechHandlers } from '../speech'
import { registerTerminalRenderDesyncEvidenceHandler } from '../terminal-render-desync-evidence'
import { registerOrcaProfileHandlers } from '../omni-profiles'
import { registerCodexAccountHandlers } from '../codex-accounts'
import { registerAgentHookHandlers } from '../agent-hooks'
import { registerCodexConfigSyncHandlers } from '../codex-config-sync'
import { getPtyIdForPaneKey } from '../pty'
import { registerAgentTrustHandlers } from '../agent-trust'
import { registerClaudeAccountHandlers } from '../claude-accounts'
import { registerMiniMaxCredentialsHandlers } from '../minimax-credentials'
import { registerGrokAccountHandlers } from '../grok-accounts'
import { registerUpdaterHandlers } from '../../window/attach-main-window-services'
import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from '../../window/clipboard-ipc-handlers'
import { isDashboardPopoutRenderer } from '../../window/dashboard-popout-window'
import type { ClaudeUsageStore } from '../../claude-usage/store'
import type { CodexUsageStore } from '../../codex-usage/store'
import type { OpenCodeUsageStore } from '../../opencode-usage/store'
import type { RateLimitService } from '../../rate-limits/service'
import type { CodexAccountService } from '../../codex-accounts/service'
import type { ClaudeAccountService } from '../../claude-accounts/service'
import type { AutomationService } from '../../automations/service'
import type { AgentAwakeService } from '../../agent-awake-service'
import type { CrashReportStore } from '../../crash-reporting/crash-report-store'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import {
  getSavedRuntimeAiVaultHostInfos,
  prepareRuntimeAiVaultSessionResume,
  resolveRuntimeAiVaultSessionTitles,
  scanRuntimeAiVaultSessions
} from '../../ai-vault/runtime-session-scanner'
import type { PluginService } from '../../plugins/plugin-service'
import type { PluginMarketplaceHandlerServices } from '../plugin-marketplaces'

let registered = false

type CoreHandlerLifecycleOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onOrcaProfileAuthMutation?: () => void
  onBeforeOrcaProfileSignOut?: () => void
  getAdditionalAiVaultCodexHomePaths?: () => readonly string[]
  prepareAiVaultSessionResume?: (
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerCoreHandlers(
  store: Store,
  runtime: OrcaRuntimeService,
  stats: StatsCollector,
  claudeUsage: ClaudeUsageStore,
  codexUsage: CodexUsageStore,
  openCodeUsage: OpenCodeUsageStore,
  codexAccounts: CodexAccountService,
  claudeAccounts: ClaudeAccountService,
  rateLimits: RateLimitService,
  mainWindowWebContentsId: number | null = null,
  automations?: AutomationService,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers,
  agentAwakeService?: AgentAwakeService,
  crashReports?: CrashReportStore,
  keybindings?: KeybindingService,
  lifecycleOptions: CoreHandlerLifecycleOptions = {},
  pluginService?: PluginService,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // Why: on macOS the app can stay alive after all windows close, then
  // openMainWindow() is called again on 'activate'. ipcMain.handle() throws
  // if a channel is registered twice, so we guard to register only once and
  // just update the per-window web-contents ID on subsequent calls.
  setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId)
  setTrustedClipboardRendererWebContentsId(mainWindowWebContentsId)
  setTrustedUIRendererWebContentsId(mainWindowWebContentsId)
  setTrustedOmnisiTeamRenderer(mainWindowWebContentsId)
  setAgentBrowserBridgeRef(runtime.getAgentBrowserBridge())
  if (registered) {
    return
  }
  registered = true

  registerAppHandlers(store, { onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch })
  registerCliHandlers()
  registerPreflightHandlers()
  registerDeliverablesHubHandlers()
  registerUsageProviderHandlers({ claudeUsage, codexUsage, openCodeUsage })
  registerCodexAccountHandlers(codexAccounts, () => store.getSettings())
  registerAgentHookHandlers(runtime, { getPtyIdForPaneKey })
  registerCodexConfigSyncHandlers(codexAccounts.runtimeHomeService)
  registerAgentTrustHandlers()
  registerClaudeAccountHandlers(claudeAccounts)
  registerMiniMaxCredentialsHandlers(rateLimits)
  registerGrokAccountHandlers()
  registerRateLimitHandlers(rateLimits, codexAccounts)
  registerGitHubHandlers(store, stats)
  registerGitLabHandlers(store)
  registerHostedReviewHandlers(store, stats)
  registerLinearHandlers()
  registerJiraHandlers()
  registerBitbucketHandlers()
  registerFeedbackHandlers()
  if (crashReports) {
    registerCrashReportingHandlers(crashReports)
  }
  registerExportHandlers()
  registerStatsHandlers(stats)
  registerMemoryHandlers(store)
  registerNotificationHandlers(store, runtime)
  registerBackofficeHandlers()
  registerConsoleWorkflowHandlers()
  registerWorkflowScriptHandlers()
  registerConsoleCompanyHandlers()
  registerConsoleRoutineConversationHandlers()
  registerConsoleTeamRoutinesHandlers()
  registerConsoleAdvertisingHandlers()
  registerConsoleQuickBooksHandlers()
  registerConsoleAccessHandlers()
  registerBrowserLoginsHandlers()
  registerConsoleDriveHandlers()
  registerRoutineAlertHandlers(store, automations)
  registerSessionLedgerHandlers()
  registerCompanyWorkspaceHandlers(() => store.getSettings())
  registerLocalOllamaHandlers(
    () => store.getSettings(),
    (updates) => store.updateSettings(updates, { notifyListeners: true })
  )
  registerConsoleLocalExecutionHandlers(runtime)
  syncBackofficeFromSettings(store.getSettings())
  startBackofficeAssignmentPoller(() =>
    BrowserWindow.getAllWindows().map((window) => window.webContents)
  )
  // Why after the backoffice sync: the first team-memory check needs the console URL.
  registerTeamMemoryHandlers()
  startTeamMemoryStatusPolling()
  registerNotebookHandlers(store)
  registerOnboardingHandlers(store)
  registerOmniCreditsIpc(store)
  registerOmniRogueHandlers(store)
  registerDashboardPopoutHandlers(store, keybindings)
  registerTerminalPreviewHandlers(runtime)
  registerDeveloperPermissionHandlers()
  // Why: diagnostics handlers are wired alongside telemetry but the two
  // lanes never share a code path — `ipc/diagnostics.ts` imports only from
  // `src/main/observability/`, never from `src/main/telemetry/`. Order is
  // not load-bearing; both register independent ipcMain channels.
  registerDiagnosticsHandlers()
  registerSessionFrameLogHandlers()
  registerTerminalRenderDesyncEvidenceHandler()
  registerComputerUsePermissionHandlers()
  registerSettingsHandlers(store, agentAwakeService)
  registerMcpConnectorHandlers(() => store.getSettings())
  registerOmnisiTeamHandlers(store, runtime)
  registerSkillsHandlers(store, runtime)
  registerSkillDeleteIpcHandlers(store, runtime)
  if (automations) {
    registerAutomationHandlers(store, automations)
  }
  if (keybindings) {
    registerKeybindingHandlers(keybindings, () => {
      void pluginService?.reconcileActivationState()
    })
  }
  if (pluginService) {
    registerPluginHandlers(store, pluginService, runtime, marketplaceServices)
  }
  registerTelemetryHandlers(store)
  registerOrcaProfileHandlers(store, {
    onBeforeRelaunch: lifecycleOptions.onBeforeRelaunch,
    onAuthMutation: lifecycleOptions.onOrcaProfileAuthMutation,
    onBeforeSignOut: lifecycleOptions.onBeforeOrcaProfileSignOut
  })
  registerBrowserHandlers()
  registerShellHandlers(store)
  registerPetHandlers()
  registerWorkflowContextHandlers()
  registerSessionHandlers(store)
  registerUIHandlers(store, { isDashboardPopoutRenderer })
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers()
  registerWorkspaceSpaceHandlers(store)
  registerWorkspacePortHandlers(store)
  registerLocalhostWorktreeLabelHandlers(store)
  registerSessionFilePreviewHandlers(store)
  if (commitMessageAgentEnv) {
    registerFilesystemHandlers(store, commitMessageAgentEnv)
  } else {
    registerFilesystemHandlers(store)
  }
  registerAssistedBriefHandlers(store, commitMessageAgentEnv)
  registerFilesystemWatcherHandlers()
  registerRuntimeHandlers(runtime)
  registerRuntimeEnvironmentHandlers(store)
  registerEphemeralVmHandlers(store, pluginService)
  registerAiVaultHandlers({
    ensureStructuredSessionOwnership: () => runtime.ensureStructuredAgentSessionHost(),
    getAdditionalCodexHomePaths: lifecycleOptions.getAdditionalAiVaultCodexHomePaths,
    prepareSessionResume: lifecycleOptions.prepareAiVaultSessionResume,
    getActiveRuntimeAiVaultHostInfos: () =>
      getSavedRuntimeAiVaultHostInfos(app.getPath('userData')),
    scanRuntimeAiVaultSessions: async (environmentId, args, options) =>
      scanRuntimeAiVaultSessions(app.getPath('userData'), environmentId, args, options),
    resolveRuntimeAiVaultSessionTitles: async (environmentId, args) =>
      resolveRuntimeAiVaultSessionTitles(app.getPath('userData'), environmentId, args),
    prepareRuntimeSessionResume: async (environmentId, args) =>
      prepareRuntimeAiVaultSessionResume(app.getPath('userData'), environmentId, args)
  })
  registerSessionSearchHandlers()
  registerNativeChatHandlers()
  registerClipboardHandlers(store)
  registerUpdaterHandlers(store)
  registerSpeechHandlers(store)
}
