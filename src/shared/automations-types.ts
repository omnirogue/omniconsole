import type {
  AutomationDefinitionContext,
  AutomationDeliveryRunFields
} from './automation-definition-context'
import type { AutomationConversationFields } from './automation-conversation'
import type { DispatchThreadFields, RunThreadFields } from './automation-run-resume-types'
import type { AutomationLaunchPreferences } from './automation-launch-preferences'
import type { AutomationStructuredOutput } from './automation-structured-output'
import type {
  AutomationDispatchLaunchFields,
  AutomationRunLaunchFields
} from './automation-launch-outcome'
import type {
  AutomationOutputBindingRequest,
  AutomationRunOutputSnapshot
} from './automation-output-types'
export type {
  AutomationOutputBindingRequest,
  AutomationRunOutputSnapshot
} from './automation-output-types'
export type { AutomationLaunchPreferences } from './automation-launch-preferences'
import type { TuiAgent } from './tui-agent'
import type { SetupDecision } from './worktree/create-types'
import type { TaskSourceContext, WorkspaceRunContext } from './task-source-context'

export type AutomationLaunchProvenanceRequest = AutomationOutputBindingRequest

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'
export type AutomationExecutionTargetType = 'local' | 'ssh'
export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_precheck'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
/** `automatic`: started by the app itself (a steward cleanup run), never by a person's click. */
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'automatic'

export { isFinalAutomationRunStatus } from './automation-run-status'

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
export type AutomationRunUsageProvider = 'claude' | 'codex'
export type AutomationRunUsageStatus = 'known' | 'unavailable'
export type AutomationRunUsageAttribution = 'provider_session_time_window'
export type AutomationRunUsageUnavailableReason =
  | 'run_not_finished'
  | 'provider_unsupported'
  | 'remote_usage_unavailable'
  | 'usage_not_enabled'
  | 'scan_failed'
  | 'no_matching_session'
  | 'ambiguous_session'

export type AutomationRunUsage = {
  status: AutomationRunUsageStatus
  provider: AutomationRunUsageProvider | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  estimatedCostSource: 'api_equivalent' | null
  providerSessionId: string | null
  attribution: AutomationRunUsageAttribution | null
  collectedAt: number
  unavailableReason: AutomationRunUsageUnavailableReason | null
  unavailableMessage: string | null
}

export type AutomationPrecheck = {
  command: string
  timeoutSeconds: number
}

export type AutomationPrecheckResult = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type Automation = AutomationConversationFields &
  AutomationDefinitionContext & {
    structuredOutput?: AutomationStructuredOutput
    launchPreferences?: AutomationLaunchPreferences
    id: string
    /** Optional client request key used to make cross-authority creates retry-safe. */
    creationKey?: string
    name: string
    prompt: string
    precheck: AutomationPrecheck | null
    agentId: TuiAgent
    /** Why: runContext carries the logical project + host setup identity for
     *  multi-host projects; projectId remains only as the legacy repo-id storage
     *  field for pre-host-context automations.
     *  @deprecated Use runContext.projectId/runContext.repoId or
     *  getAutomationRunRepoId(). */
    runContext?: WorkspaceRunContext | null
    /** Why: task/provider data can come from a different host/account than the
     *  workspace run target, so automations persist it separately. */
    sourceContext?: TaskSourceContext | null
    /** @deprecated Legacy repo-id compatibility field. New code should persist
     *  runContext and use getAutomationRunRepoId() for fallback reads. */
    projectId: string
    executionTargetType: AutomationExecutionTargetType
    executionTargetId: string
    /** Why: pins the SSH registration incarnation this record was attached to, so a
     *  removed-and-re-added target reusing the id can't silently adopt it. Absent on
     *  local records, on legacy records, and on orphans whose target is gone. */
    executionTargetGeneration?: number
    schedulerOwner: AutomationSchedulerOwner
    workspaceMode: AutomationWorkspaceMode
    workspaceId: string | null
    baseBranch: string | null
    setupDecision?: SetupDecision
    reuseSession: boolean
    timezone: string
    rrule: string
    dtstart: number
    enabled: boolean
    nextRunAt: number
    lastRunAt?: number
    missedRunPolicy: AutomationMissedRunPolicy
    missedRunGraceMinutes: number
    createdAt: number
    updatedAt: number
  }

export type AutomationRunOptions = {
  promptOverride?: string
  titleSuffix?: string
  /** Set only by main-process code; no RPC schema carries it. Absent = `manual`. */
  trigger?: 'automatic'
}

// Why the intersection: the provider-thread fields live in automation-run-resume-types.ts
// (this file is at its line budget); a run whose pane is gone resumes that thread.
export type AutomationRun = RunThreadFields &
  AutomationRunLaunchFields &
  AutomationDeliveryRunFields & {
    /** Only fresh launches may be retired automatically after a startup failure. */
    ownsTerminal?: boolean
    promptOverride?: string | null
    id: string
    automationId: string
    runContext?: WorkspaceRunContext | null
    sourceContext?: TaskSourceContext | null
    title: string
    scheduledFor: number
    status: AutomationRunStatus
    trigger: AutomationRunTrigger
    workspaceId: string | null
    /** Why: run history must remain understandable after the backing workspace
     *  is deleted and its live metadata is gone. */
    workspaceDisplayName?: string | null
    sessionKind: 'terminal'
    chatSessionId: string | null
    terminalSessionId: string | null
    /** Why: a terminal tab can later point at a different pane/PTY. Automation
     *  run reopening must target the pane that actually executed the run. */
    terminalPaneKey: string | null
    terminalPtyId: string | null
    /** Execution owner binding captured at dispatch; absent legacy runs stay unproven after restart. */
    terminalProcessIncarnation?: string
    outputSnapshot: AutomationRunOutputSnapshot | null
    precheckResult: AutomationPrecheckResult | null
    usage: AutomationRunUsage | null
    error: string | null
    startedAt: number | null
    dispatchedAt: number | null
    createdAt: number
    /** Why: run titles must stay unique once retention prunes old runs, so the
     *  number can no longer be derived from how many runs are currently kept. */
    runNumber?: number
    /** Why: a target that cannot resolve refuses every occurrence, so consecutive
     *  identical refusals fold into this record instead of one row each. Counts the
     *  occurrences the record stands for; absent means one. */
    occurrenceCount?: number
    /** `scheduledFor` of the most recently folded occurrence; absent until one folds. */
    lastOccurrenceAt?: number
  }

export type AutomationCreateInput = AutomationConversationFields &
  AutomationDefinitionContext & {
    structuredOutput?: AutomationStructuredOutput | null
    launchPreferences?: AutomationLaunchPreferences | null
    /** Optional idempotency key; repeated creates return the original record. */
    creationKey?: string
    name: string
    prompt: string
    precheck?: AutomationPrecheck | null
    agentId: TuiAgent
    runContext?: WorkspaceRunContext | null
    sourceContext?: TaskSourceContext | null
    /** @deprecated Legacy repo-id compatibility field required for older stored
     *  automations and clients. Pair it with runContext for new writes. */
    projectId: string
    workspaceMode: AutomationWorkspaceMode
    workspaceId?: string | null
    baseBranch?: string | null
    setupDecision?: SetupDecision
    reuseSession?: boolean
    timezone: string
    rrule: string
    dtstart: number
    enabled?: boolean
    missedRunGraceMinutes?: number
  }

export type AutomationUpdateInput = AutomationConversationFields &
  AutomationDefinitionContext & {
    structuredOutput?: AutomationStructuredOutput | null
    launchPreferences?: AutomationLaunchPreferences | null
  } & Partial<
    Pick<
      Automation,
      | 'name'
      | 'prompt'
      | 'precheck'
      | 'agentId'
      | 'runContext'
      | 'sourceContext'
      | 'projectId'
      | 'workspaceMode'
      | 'workspaceId'
      | 'baseBranch'
      | 'setupDecision'
      | 'reuseSession'
      | 'timezone'
      | 'rrule'
      | 'dtstart'
      | 'enabled'
      | 'missedRunGraceMinutes'
    >
  >

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
  dispatchToken: string
  launchProvenance?: AutomationLaunchProvenanceRequest
  outputBinding?: AutomationOutputBindingRequest
  /** The project's brief for a routine run in one, resolved for its computer by main. */
  projectBrief?: string
}

export type AutomationDispatchResult = DispatchThreadFields &
  AutomationDispatchLaunchFields &
  AutomationDeliveryRunFields & {
    ownsTerminal?: boolean
    runId: string
    status: AutomationRunStatus
    workspaceId?: string | null
    workspaceDisplayName?: string | null
    terminalSessionId?: string | null
    terminalPaneKey?: string | null
    terminalPtyId?: string | null
    outputSnapshot?: AutomationRunOutputSnapshot | null
    precheckResult?: AutomationPrecheckResult | null
    usage?: AutomationRunUsage | null
    error?: string | null
  }

export type {
  ExternalAutomationProvider,
  ExternalAutomationManagerStatus,
  ExternalAutomationAction,
  ExternalAutomationRunStatus,
  ExternalAutomationTarget,
  ExternalAutomationJob,
  ExternalAutomationRun,
  ExternalAutomationRunsPage,
  ExternalAutomationRunsInput,
  ExternalAutomationCreateInput,
  ExternalAutomationUpdateInput,
  ExternalAutomationManager,
  ExternalAutomationActionInput
} from './external-automation-types'
