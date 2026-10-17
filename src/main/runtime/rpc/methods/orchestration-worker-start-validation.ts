import type { OrchestrationDb } from '../../orchestration/db'
import { readCanonicalWorkerRecord } from '../../orchestration/canonical-worker-record'
import { ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { getConsoleJobBinding } from '../../orchestration/console-job-binding'
import { readConsoleJobActivationReceipt } from '../../orchestration/console-job-activation-receipt'
import type { FederationAttachStartInput } from './orchestration-federation-start-schema'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  createWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './orchestration-worker-launch-preferences'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'

type WorkerStartLaunch = ReturnType<typeof resolveWorkerLaunchPreferences>

export function validatedWorkerReadinessTimeoutMs(timeoutMs: number | undefined): number {
  if (!isWorkerStartTimeoutWithinTimerLimit(timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  return resolveWorkerStartReadinessTimeoutMs(timeoutMs)
}

/** Why: an admitted console job is projected onto a hub-bound task exactly like a
 *  Hub-runner card, so the fence below has to tell the two admissions apart from
 *  stored rows rather than from the order its callers happen to run in. A local
 *  activation qualifies only when the Run carries the server-issued console job
 *  binding for that same card, the stored activation receipt the main-only
 *  console launch path wrote from the BFF's response, and the request replays
 *  that binding's local job. The receipt is read from the Run, never from the
 *  request: nothing a caller can send over RPC or the CLI can produce one. */
function isConsoleAdmittedLocalStart(
  db: OrchestrationDb,
  hubTaskId: string,
  admission: ConsoleAdmittedLocalStart | undefined
): boolean {
  if (!admission?.attempt) {
    return false
  }
  const binding = getConsoleJobBinding(db, admission.runId)
  const activation = readConsoleJobActivationReceipt(db, admission.runId)
  return (
    binding !== null &&
    activation !== null &&
    activation.jobId === binding.jobId &&
    binding.taskId === hubTaskId &&
    admission.attempt.job.taskId === binding.taskId &&
    admission.attempt.job.id === binding.jobId &&
    admission.attempt.job.workflowId === binding.workflowId &&
    admission.attempt.job.placement === 'local'
  )
}

export type ConsoleAdmittedLocalStart = {
  runId: string
  attempt: WorkerStartInput['consoleExecution']
}

export function assertUnboundLocalWorkerStart(
  db: OrchestrationDb,
  taskId: string,
  consoleAdmission?: ConsoleAdmittedLocalStart
): void {
  const previous = db.getDispatchContext(taskId)
  // Why: a Hub runner's canonical execution owns its own start receipt; no local
  // worker-start may resume or retry it, console admission or not.
  if (previous && readCanonicalWorkerRecord(db, previous.id)) {
    throw new OrchestrationError(
      'consumer_fenced',
      'This canonical execution requires Hub admission; local worker-start cannot retry it.'
    )
  }
  const task = db.getTask(taskId)
  // Why: the card binding alone cannot say who owns the execution. Only a run the
  // Hub dispatched (console job admission, inherited canonical execution, or
  // explicit hub admission) is reserved for workerPrepare. A run a signed-in
  // person bound to a card from this dispatcher reports to the card but is
  // started here, so Build + Review and `run-create --hub-task-id` keep working
  // -- their business mutations stay fenced by the read-only card rules.
  const origin = task ? db.getRun(task.run_id)?.origin : undefined
  if (origin !== 'hub_dispatched') {
    return
  }
  if (task?.hub_task_id && isConsoleAdmittedLocalStart(db, task.hub_task_id, consoleAdmission)) {
    return
  }
  throw new OrchestrationError(
    'consumer_fenced',
    'This canonical execution requires Hub admission; local worker-start cannot retry it.'
  )
}

export function assertHubWorkerUsesFreshTerminal(
  hubTaskId: string | null | undefined,
  terminal: string | undefined
): void {
  if (hubTaskId && terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      'Hub-bound workers require a new agent terminal to establish their launch environment. Omit --terminal.'
    )
  }
}

export function assertFederatedWorkerHubBinding(args: {
  hubTaskId: string | null | undefined
  terminal: string | undefined
  capabilities: readonly string[] | undefined
  serverName: string
}): void {
  if (
    args.hubTaskId &&
    !args.capabilities?.includes(ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} cannot preserve hub card binding. Update the server before launching bound work. No effects were applied.`
    )
  }
  assertHubWorkerUsesFreshTerminal(args.hubTaskId, args.terminal)
}

export function validateFederatedWorkerStartPlacement(
  params: WorkerStartInput,
  createsWorktree: boolean
): void {
  if (params.permissionMode !== undefined) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Explicit worker permission mode requires a local worker; no remote effects were applied.'
    )
  }
  if (
    params.executionBrief !== undefined ||
    params.continueFrom !== undefined ||
    params.consoleExecution !== undefined
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Execution briefs require a local worker; no remote effects were applied.'
    )
  }
  // Why: both are resolved against THIS host's filesystem and account directories.
  // A federated dispatch runs somewhere else, so neither can be honoured there.
  if (params.cwd !== undefined || params.accountChoiceId !== undefined) {
    throw new OrchestrationError(
      'capability_unsupported',
      'A working folder and an account profile are local placements; no remote effects were applied.'
    )
  }
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote new-top-level requires --name and an explicit --repo from remote discovery.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (!params.terminal && (!params.agent || !isTuiAgent(params.agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when remote worker-start creates a terminal.'
    )
  }
}

export function prepareLocalWorkerStart(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (createsWorktree && !params.name) {
    throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
  }
  if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  return resolveWorkerStartAgent({
    runtime,
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    ...('openrouterCandidates' in params
      ? {
          openrouterCandidates: params.openrouterCandidates as string[] | undefined
        }
      : {}),
    effort: params.effort,
    permissionMode: params.permissionMode,
    missingAgentMessage: 'A configured --agent is required when worker-start creates a terminal.'
  })
}

export function prepareFederationAttachmentWorkerStart(args: {
  params: FederationAttachStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  const { params, createsWorktree, runtime } = args
  assertWorkerLaunchPreferencesCreateTerminal(params)
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires --name and an explicit --repo.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (
    !createsWorktree &&
    (params.name || params.repo || params.baseBranch || params.setup || params.setupSource)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  return resolveWorkerStartAgent({
    runtime,
    terminal: params.terminal,
    agent: params.agent,
    model: params.model,
    ...('openrouterCandidates' in params
      ? {
          openrouterCandidates: params.openrouterCandidates as string[] | undefined
        }
      : {}),
    effort: params.effort,
    missingAgentMessage:
      'A configured --agent is required when federated worker-start creates a terminal.'
  })
}

function resolveWorkerStartAgent(args: {
  runtime: OrcaRuntimeService
  terminal?: string
  agent?: string
  model?: string
  openrouterCandidates?: string[]
  effort?: string
  permissionMode?: 'yolo' | 'read-only'
  missingAgentMessage: string
}): { agent: TuiAgent | undefined; launch: WorkerStartLaunch } {
  if (!args.terminal && (!args.agent || !isTuiAgent(args.agent))) {
    throw new OrchestrationError('agent_unconfigured', args.missingAgentMessage)
  }
  const agent = args.agent as TuiAgent | undefined
  if (agent) {
    args.runtime.validateOrchestrationAgentLauncher(agent)
    return {
      agent,
      launch: resolveWorkerLaunchPreferences({
        agent,
        model: args.model,
        openrouterCandidates: args.openrouterCandidates,
        effort: args.effort,
        permissionMode: args.permissionMode
      })
    }
  }
  return {
    agent: undefined,
    launch: {
      preferences: undefined,
      receipt: createWorkerLaunchReceipt({ agent: null })
    }
  }
}
