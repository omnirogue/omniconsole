import type { CustomerServiceLaunchApi } from '../shared/customer-service-launch'
import type { RoutineAlertApi } from '../shared/routine-alert-contract'
import type { ConsoleRoutineConversationApi } from '../shared/console-routine-conversation-contract'
import type { ConsoleTeamRoutinesApi } from '../shared/console-team-routines-contract'
import type { TaskPriority, TaskPlan } from '../shared/task-details'
import type { RoomsApi } from '../shared/rooms'
import type { BackofficeConnectionTest } from '../shared/backoffice-connection'
import type { ConsoleWorkflowApi } from '../shared/console-workflow-types'
import type { ConsoleHandoffApi } from '../shared/console-handoff-contract'
import type { ConsoleAdvertisingApi } from '../shared/console-advertising-contract'
import type { ConsoleCompaniesApi } from '../shared/console-companies-contract'
import type { ConsoleQuickBooksApi } from '../shared/console-quickbooks-contract'
import type { TeamMemoryApi } from '../shared/team-memory-contract'
import type { ConsoleAccessApi } from '../shared/console-access-contract'
import type { BrowserLoginsApi } from '../shared/browser-logins-contract'
import type { ConsoleDriveApi } from '../shared/console-drive-contract'
import type { SessionLedgerApi } from '../shared/session-ledger-contract'
import type { SessionFrameLogApi } from './api/session-frame-log-api'
import type { AssistedBriefApi } from '../shared/assisted-brief-contract'
import type { ConsoleLocalExecutionClientApi } from '../shared/console-local-execution'
import type {
  BackofficeArchiveResult,
  BackofficeAssignmentEvent,
  BackofficeFeedResult,
  BackofficeInboxSendArgs,
  BackofficeInboxSendResult,
  BackofficeTaskCompletionResult,
  BackofficeTaskCreationResult,
  BackofficeTodoListArgs,
  BackofficeTodoResult
} from '../shared/backoffice-work-types'
import type { AccountSyncApi } from '../shared/account-sync-types'
import type { BackofficeOpenTarget } from '../shared/backoffice-task-link'
import type { BuildReviewApi } from './api/build-review-api'
import type { LocalRunApi } from './api/local-run-api'
import type { LocalWorkflowApi } from './api/local-workflow-api'
import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ClaudeAccountsApi,
  CodexAccountsApi,
  CodexConfigSyncApi,
  GrokAccountsApi,
  MinimaxCredentialsApi
} from './api/agent-account-api'
import type { HooksApi } from './api/agent-hook-api'
import type { SkillsApi } from './api/agent-skill-api'
import type { AgentAwakeApi, AgentStatusApi, AgentTrustApi } from './api/agent-status-api'
import type {
  ClaudeUsageApi,
  CodexUsageApi,
  OpenCodeUsageApi,
  RateLimitsApi
} from './api/agent-usage-api'
import type { AiVaultApi } from './api/ai-vault-api'
import type { SessionSearchApi } from './api/session-search-api'
import type { AppApi, E2EApi, PlatformApi } from './api/app-api'
import type { AutomationsApi } from './api/automation-api'
import type { BrowserApi } from './api/browser-api'
import type { CliApi } from './api/cli-install-api'
import type { CrashReportsApi, FeedbackApi } from './api/crash-report-api'
import type { DashboardApi, TerminalPreviewApi } from './api/dashboard-api'
import type { DocPreviewApi } from './api/doc-preview-api'
import type { EmulatorApi } from './api/emulator-api'
import type { EphemeralVmApi } from './api/ephemeral-vm-api'
import type { ExportApi, FilesystemApi } from './api/filesystem-api'
import type { GitInspectionApi } from './api/git-inspection-api'
import type { GitOperationApi } from './api/git-operation-api'
import type { GithubPullRequestApi } from './api/github-pull-request-api'
import type { GithubWorkItemApi } from './api/github-work-item-api'
import type { GitLabApi } from './api/gitlab-api'
import type { BitbucketApi, HostedReviewApi } from './api/hosted-review-api'
import type { JiraApi } from './api/jira-api'
import type { LinearApi } from './api/linear-api'
import type { MobileApi } from './api/mobile-api'
import type { NativeChatApi } from './api/native-chat-api'
import type { OnboardingApi, StarNagApi } from './api/onboarding-api'
import type { OmniRogueApi } from './api/omnirogue-api'
import type { OrcaProfileApi } from './api/omni-profile-api'
import type {
  ComputerUsePermissionsApi,
  DeveloperPermissionsApi,
  MacosTccPromptsApi,
  NotificationsApi
} from './api/os-permission-api'
import type { PetApi } from './api/pet-api'
import type { PluginsApi } from './api/plugin-host-api'
import type { PreflightApi } from './api/preflight-api'
import type { PtyApi } from './api/pty-api'
import type { CompanyWorkspacesApi, LocalOllamaPreloadApi } from './api/company-workspaces-api'
import type { ProjectGroupsApi, ProjectsApi, RepositoryApi } from './api/repository-api'
import type { RuntimeApi } from './api/runtime-api'
import type { KeybindingsApi, SettingsApi } from './api/settings-api'
import type { McpConnectorsApi } from '../shared/mcp-connectors'
import type { ShellApi } from './api/shell-api'
import type { SpeechApi } from './api/speech-api'
import type { SshApi } from './api/ssh-api'
import type { DiagnosticsApi, MemoryApi, StatsApi, TelemetryApi } from './api/telemetry-api'
import type { UiCommandEventApi } from './api/ui-command-event-api'
import type { UiWindowApi } from './api/ui-window-api'
import type { UpdaterApi } from './api/updater-api'
import type { WorkspaceCleanupApi, WorkspaceSpaceApi } from './api/workspace-cleanup-api'
import type { LocalhostWorktreeLabelsApi, WorkspacePortsApi } from './api/workspace-port-api'
import type { SessionFilesApi } from './api/session-files-api'
import type { WorkspaceSessionApi } from './api/workspace-session-api'
import type { FolderWorkspacesApi, SparsePresetsApi, WorktreeApi } from './api/worktree-api'

// Flattens contracts that share one PreloadApi key: an intersection is not type-identical to the flat shape.
type Merged<T> = { [K in keyof T]: T[K] }

export type BackofficeApi = AccountSyncApi & {
  testConnection: (args: {
    url: string
    requireHttps: boolean
  }) => Promise<BackofficeConnectionTest>
  listTodo: (args?: BackofficeTodoListArgs) => Promise<BackofficeTodoResult>
  feed: (args: { path: string }) => Promise<BackofficeFeedResult>
  inboxSend: (args: BackofficeInboxSendArgs) => Promise<BackofficeInboxSendResult>
  completeTask: (args: {
    taskId: string
    expectedRevision: number
  }) => Promise<BackofficeTaskCompletionResult>
  archiveTask: (args: { taskId: string }) => Promise<BackofficeArchiveResult>
  createTask: (args: {
    title: string
    description?: string
    acceptanceCriteria?: string
    taskPlan?: TaskPlan | null
    dueDate?: string | null
    priority?: TaskPriority
    sequentialSteps?: string[]
    ownerEmployeeId?: string
    companyId?: string
    companySlug?: string
    additionalCompanySlugs?: readonly string[]
    /** Files the card in the Kanban's Proposed lane. */
    proposed?: boolean
    unitId?: string
    projectId?: string
    goalId?: string
    actorIds?: readonly string[]
  }) => Promise<BackofficeTaskCreationResult>
  consumePendingOpenTask: () => Promise<BackofficeOpenTarget | null>
  onOpenTask: (callback: (event: BackofficeOpenTarget) => void) => () => void
  onAssignments: (callback: (event: BackofficeAssignmentEvent) => void) => () => void
}

export type PreloadApi = LocalOllamaPreloadApi & {
  alerts: RoutineAlertApi
  consoleWorkflows: ConsoleWorkflowApi
  consoleHandoffs?: ConsoleHandoffApi
  /** Sal's companies view; the web client answers that it is unavailable. */
  consoleRoutineConversation?: ConsoleRoutineConversationApi
  consoleTeamRoutines?: ConsoleTeamRoutinesApi
  consoleAdvertising?: ConsoleAdvertisingApi
  customerServiceLaunch?: CustomerServiceLaunchApi
  consoleCompanies?: ConsoleCompaniesApi
  consoleQuickBooks?: ConsoleQuickBooksApi
  /** Whether Sal and Uma's instructions are loaded in my connector; absent in the web client. */
  teamMemory?: TeamMemoryApi
  /** The Tool Shelf: my tools, and for super admins everybody's; the web client answers unavailable. */
  consoleAccess?: ConsoleAccessApi
  /** The browser-login rail: shared AirTop profiles and their re-login flow; the web client answers unavailable. */
  consoleBrowserLogins?: BrowserLoginsApi
  consoleDrive?: ConsoleDriveApi
  /** The estate session ledger: live/today rows, peers on my branch or card, this desktop's own rows. */
  sessionLedger?: SessionLedgerApi
  /** Session frame log (session-count fix step 0); absent in the web client. */
  sessionFrameLog?: SessionFrameLogApi
  /** Company folders on the desktop host; the web client refuses to create any. */
  companyWorkspaces?: CompanyWorkspacesApi
  /** Optional: absent in the web client, which cannot run local drafting agents. */
  assistedBrief?: AssistedBriefApi
  consoleLocalExecution: ConsoleLocalExecutionClientApi
  app: AppApi
  orcaProfiles: OrcaProfileApi
  platform: PlatformApi
  e2e: E2EApi
  repos: RepositoryApi
  projects: ProjectsApi
  projectGroups: ProjectGroupsApi
  folderWorkspaces: FolderWorkspacesApi
  sparsePresets: SparsePresetsApi
  worktrees: WorktreeApi
  workspaceCleanup: WorkspaceCleanupApi
  workspaceSpace: WorkspaceSpaceApi
  workspacePorts: WorkspacePortsApi
  pty: PtyApi
  feedback: FeedbackApi
  crashReports: CrashReportsApi
  export: ExportApi
  gh: Merged<GithubPullRequestApi & GithubWorkItemApi>
  hostedReview: HostedReviewApi
  gl: GitLabApi
  bitbucket: BitbucketApi
  linear: LinearApi
  jira: JiraApi
  starNag: StarNagApi
  telemetryTrack: TelemetryApi['telemetryTrack']
  telemetrySetOptIn: TelemetryApi['telemetrySetOptIn']
  diagnostics: DiagnosticsApi
  telemetryGetConsentState: TelemetryApi['telemetryGetConsentState']
  telemetryAcknowledgeBanner: TelemetryApi['telemetryAcknowledgeBanner']
  settings: SettingsApi
  mcpConnectors?: McpConnectorsApi
  agentAwake: AgentAwakeApi
  localhostWorktreeLabels: LocalhostWorktreeLabelsApi
  sessionFiles?: SessionFilesApi
  keybindings: KeybindingsApi
  codexAccounts: CodexAccountsApi
  claudeAccounts: ClaudeAccountsApi
  cli: CliApi
  codexConfigSync: CodexConfigSyncApi
  agentTrust: AgentTrustApi
  preflight: PreflightApi
  rooms?: RoomsApi
  omnirogue?: OmniRogueApi
  backoffice: BackofficeApi
  notifications: NotificationsApi
  onboarding: OnboardingApi
  dashboard: DashboardApi
  terminalPreview: TerminalPreviewApi
  macosTccPrompts: MacosTccPromptsApi
  developerPermissions: DeveloperPermissionsApi
  computerUsePermissions: ComputerUsePermissionsApi
  shell: ShellApi
  skills: SkillsApi
  pet: PetApi
  browser: BrowserApi
  emulator: EmulatorApi
  hooks: HooksApi
  ephemeralVm: EphemeralVmApi
  cache: WorkspaceSessionApi['cache']
  session: WorkspaceSessionApi['session']
  remoteWorkspace: WorkspaceSessionApi['remoteWorkspace']
  updater: UpdaterApi
  notebook: FilesystemApi['notebook']
  docPreview: DocPreviewApi['docPreview']
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  aiVault: AiVaultApi
  sessionSearch: SessionSearchApi
  nativeChat: NativeChatApi
  fs: FilesystemApi['fs']
  git: Merged<GitInspectionApi & GitOperationApi>
  ui: Merged<UiCommandEventApi & UiWindowApi>
  runtime: RuntimeApi['runtime']
  runtimeEnvironments: RuntimeApi['runtimeEnvironments']
  rateLimits: RateLimitsApi
  minimaxCredentials: MinimaxCredentialsApi
  grokAccounts: GrokAccountsApi
  ssh: SshApi
  buildReview: BuildReviewApi
  localRun: LocalRunApi
  localWorkflow: LocalWorkflowApi
  automations: AutomationsApi
  wsl: RuntimeApi['wsl']
  pwsh: RuntimeApi['pwsh']
  gitBash: RuntimeApi['gitBash']
  plugins: PluginsApi
  agentStatus: AgentStatusApi
  mobile: MobileApi
  speech: SpeechApi
}

export type * from './api/public-api-types'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
