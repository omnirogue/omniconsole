import { sessionOutcomeActionSchema } from '../../shared/session-outcome-types'
import type { ConsoleTaskContinuationRequest } from '../../shared/console-local-execution'
import type { ConsoleTaskContinuationResult } from '../../shared/console-task-continuation'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcomeAction,
  SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'

let continuation:
  | ((
      runtime: OrcaRuntimeService,
      input: ConsoleTaskContinuationRequest
    ) => Promise<ConsoleTaskContinuationResult>)
  | null = null
export function installSessionOutcomeTaskContinuation(
  adapter: NonNullable<typeof continuation>
): void {
  continuation = adapter
}

/** These local checks run before a durable launch marker because no request has been sent. */
export function assertSessionOutcomeTaskAdmission(
  action: SessionOutcomeAction
): asserts action is SessionOutcomeAction & { model: string } {
  if (!continuation) {
    throw new Error('The signed task-continuation adapter is unavailable on this execution host.')
  }
  if (
    !['codex', 'claude', 'grok', 'omp'].includes(action.agent) ||
    !action.model ||
    action.accountChoiceId
  ) {
    throw new Error(
      'Task continuation requires a supported explicit provider/model. The server contract cannot preserve a selected account; update that contract before dispatching.'
    )
  }
}

export class SessionOutcomeTaskContinuationError extends Error {
  constructor(
    message: string,
    readonly launchDisposition: 'not-started' | 'unverifiable'
  ) {
    super(message)
  }
}

/** The task's existing server admission owns retries by the persisted operation ID. */
export async function continueSessionOutcomeTask(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  action: SessionOutcomeAction,
  attempt: SessionOutcomeAttempt,
  instruction: string
): Promise<SessionOutcomeAttempt> {
  assertSessionOutcomeTaskAdmission(action)
  const result = await continuation!(runtime, {
    operationId: attempt.id,
    taskId: chain.outcomeSet!.continuation.taskId!,
    agent: action.agent as ConsoleTaskContinuationRequest['agent'],
    model: action.model,
    ...(action.openrouterCandidates !== undefined
      ? { openrouterCandidates: action.openrouterCandidates }
      : {}),
    ...(action.effort ? { effort: action.effort } : {}),
    instruction,
    worktree: `id:${chain.worktreeId}`
  })
  if (!result.ok) {
    throw new SessionOutcomeTaskContinuationError(result.error.message, result.launchDisposition)
  }
  const dispatch = result.data.dispatchId
    ? runtime.getOrchestrationDb().getDispatchContextById(result.data.dispatchId)
    : undefined
  return {
    ...attempt,
    continuationTaskId: chain.outcomeSet!.continuation.taskId,
    taskId: dispatch?.task_id,
    dispatchId: result.data.dispatchId ?? undefined,
    runId: result.data.runId ?? undefined,
    state: result.data.state === 'running' ? 'running' : 'unverifiable',
    updatedAt: Date.now()
  }
}

export function sessionOutcomeAttemptAction(attempt: SessionOutcomeAttempt): SessionOutcomeAction {
  const [
    id,
    instruction,
    conditionIds,
    agent,
    model,
    effort,
    accountChoiceId,
    openrouterCandidates
  ] = JSON.parse(attempt.actionKey)
  return sessionOutcomeActionSchema.parse({
    id,
    instruction,
    conditionIds,
    agent,
    authority: 'existing-user-authority',
    ...(model ? { model } : {}),
    ...(openrouterCandidates !== undefined ? { openrouterCandidates } : {}),
    ...(effort ? { effort } : {}),
    ...(accountChoiceId ? { accountChoiceId } : {})
  })
}
