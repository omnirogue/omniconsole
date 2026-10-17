import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AutomationLaunchProvenanceRequest,
  AutomationOutputBindingRequest
} from '../../../../shared/automations-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalStartupCwdMissingDirFallback } from '../../../../shared/terminal-startup-cwd'
import type { OrcaRuntimeService } from '../../../runtime/omni-runtime'
import type { Store } from '../../../persistence'
import type { PtySpawnResult } from '../../../providers/types'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'
import type {
  CodexHomePtySpawnedLifecycleArgs,
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from '../host-env/types'
import type { CodexResumeLaunch, PreparedCodexResumeHome } from '../host-env/codex-resume'
import type { StablePaneOwner } from '../pane/stable-owner'

export type PtySpawnIpcArgs = {
  cols: number
  rows: number
  cwd?: string
  // Why: fresh local spawns opt into recovering a saved cwd whose dir was deleted (#7239); reattach/remote need exact cwd, so the flag alone isn't sufficient.
  cwdFallback?: 'worktree'
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  launchConfig?: SleepingAgentLaunchConfig
  interruptedRestore?: boolean
  // Why loose: renderer-attributed launch cause for latency telemetry; main validates it
  // against the fixed trigger tokens and never branches on it (spawn-launch-attribution.ts).
  launchReference?: unknown
  launchParentPaneKey?: unknown
  launchTrigger?: unknown
  launchVisible?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: unknown
  launchAgent?: TuiAgent
  automationLaunchProvenance?: AutomationLaunchProvenanceRequest
  automationOutputBinding?: AutomationOutputBindingRequest
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  worktreeId?: string
  sessionId?: string
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalColorQueryReplies?: {
    foreground?: unknown
    background?: unknown
  }
  // Why: hidden-at-spawn declaration (terminal-query-authority.md §races) — main marks hidden before byte zero so the gate owns spawn-time queries.
  initiallyHidden?: boolean
  // Why: closes the SIGKILL race (INVESTIGATION.md) by letting main sync-flush the binding before pty:spawn returns; only the Ctrl+T daemon-host path threads these.
  tabId?: string
  leafId?: string
  // Why: an agent start a person just asked for (a click or opening its tab) goes ahead of
  // queued background starts in the app-wide admission window; validated as a literal.
  launchPriority?: 'person'
  // Why: the renderer pane this start is for, so revealing it while its start waits in the
  // admission queue can promote it (pty:promoteAgentLaunch); validated as a bounded string.
  launchAdmissionKey?: string
  // Why: one-off id of this start, so the pane's transport can cancel it while it waits in the
  // admission queue (pty:cancelAgentLaunch); validated as a bounded string.
  launchAdmissionToken?: string
  // Why: renderer-threaded launch telemetry (telemetry-plan.md§Agent launch semantics); loosely typed because the main-side schema validator is the single enforcement point.
  telemetry?: {
    agent_kind?: unknown
    launch_source?: unknown
    request_kind?: unknown
  }
}

export type AdoptStablePaneArgs = {
  cols: number
  rows: number
  cwd?: string
  connectionId?: string | null
  worktreeId: string
  preAllocatedHandle?: string
  tabId: string
  leafId: string
  ownsPaneSpawnReservation?: true
}

export type AdoptStablePaneResult = {
  result: PtySpawnResult
  owner: StablePaneOwner
  materialized?: true
}

export type PtySpawnIpcDeps = {
  runtime?: OrcaRuntimeService
  store?: Store
  getSettings?: () => GlobalSettings
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  prepareClaudeAuth?: PrepareClaudeAuth
  options?: {
    prepareCodexSessionResume?: PrepareCodexSessionResume
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
  }
  getLocalPtyStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
  adoptStablePane: (args: AdoptStablePaneArgs) => Promise<AdoptStablePaneResult | null>
  assertFolderWorkspacePtyPathUsable: (worktreeId: string | undefined) => Promise<void> | void
  resolvePtySpawnStartupCwd: (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ) => string | undefined
  localStartupCwdDirectoryExists: (path: string) => boolean
  prepareCodexResumeHome: (args: {
    connectionId?: string | null
    launchAgent?: TuiAgent
    providerSession?: AgentProviderSessionMetadata
    target: CodexAccountSelectionTarget
    launchEnv?: NodeJS.ProcessEnv
    workspacePath?: string
  }) => PreparedCodexResumeHome | null
  noCodexResumeLaunch: (command: string | undefined) => CodexResumeLaunch
  resolveCodexResumeLaunch: (
    command: string | undefined,
    prepared: PreparedCodexResumeHome
  ) => Promise<CodexResumeLaunch>
  reconcileSharedRuntimeResumeHome: (
    resumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }>,
    resolveCurrent: () => string | null | Promise<string | null>
  ) => Promise<string>
  stripSequencedStartupResumeArgv: <T extends Record<string, string> | undefined>(
    env: T,
    launch: CodexResumeLaunch
  ) => T
  transitionSpawnHiddenRendererPtyDeliveryState: (id: string, hidden: boolean) => void
  trustedTerminalHandleEnv: Set<string>
  sendPtySpawnedToRenderer: (id: string) => void
  syncPtyBackgroundedDelivery: (id: string, caller: string) => void
}
