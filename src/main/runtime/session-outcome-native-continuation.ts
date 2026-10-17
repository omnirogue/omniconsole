import { createHash } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcomeAction,
  SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { createDesktopCoordinator } from './orchestration/desktop-coordinator'
import { createOrchestrationCaller } from './build-review/build-review-rpc-call'
import { assertUnboundLocalWorkerStart } from './rpc/methods/orchestration-worker-start-validation'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { sessionOutcomeAttemptAction } from './session-outcome-task-continuation'

const digest = (brief: string): string => createHash('sha256').update(brief).digest('hex')

/** Native Sessions use the same immutable card projection as Build + Review.
 * This does not admit/revise a business contract or mutate the hub card. */
export async function launchNativeSessionOutcomeAction(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  action: SessionOutcomeAction,
  initial: SessionOutcomeAttempt,
  brief: string,
  persist: (attempt: SessionOutcomeAttempt) => void
): Promise<SessionOutcomeAttempt> {
  const set = chain.outcomeSet!
  const source = set.continuation.nativeSource!
  const db = runtime.getOrchestrationDb()
  const run = db.getRun(source.runId)
  const task = db.getTask(source.projectionTaskId)
  const sourceDispatch = db.getDispatchContextById(source.sourceDispatchId)
  if (
    !set.continuation.sourceReady ||
    !set.continuation.principal ||
    (await readSessionOutcomePrincipal()) !== set.continuation.principal
  ) {
    throw new Error('The original signed person and settled source are required to continue.')
  }
  if (
    run?.origin !== 'local_bound' ||
    run.console_job ||
    run.hub_task_id !== set.continuation.taskId ||
    task?.run_id !== run.id ||
    task.hub_task_id !== run.hub_task_id ||
    sourceDispatch?.task_id !== task.id ||
    sourceDispatch.run_id !== run.id
  ) {
    throw new Error('The stored source is not this card’s native dispatcher Run.')
  }
  assertUnboundLocalWorkerStart(db, task.id)
  const ownAttempts = set.attempts.filter(
    (attempt) => attempt.nativeContinuation && attempt.id !== initial.id
  )
  if (
    ownAttempts.some((attempt) =>
      ['prepared', 'launching', 'running', 'unverifiable'].includes(attempt.state)
    )
  ) {
    throw new Error('Reconcile the pending native dispatch before sharing this card projection.')
  }
  const previousDispatchId =
    ownAttempts.findLast((attempt) => Boolean(attempt.dispatchId))?.dispatchId ??
    source.sourceDispatchId
  const previous = db.getDispatchContextById(previousDispatchId)
  const worker = db.getWorkerDispatch(previousDispatchId)
  if (
    previous?.task_id !== task.id ||
    db.getDispatchContext(task.id)?.id !== previousDispatchId ||
    !['completed', 'failed'].includes(task.status) ||
    !['completed', 'failed'].includes(previous.status) ||
    !worker ||
    !['succeeded', 'failed'].includes(worker.state)
  ) {
    throw new Error(
      'Continue requires this plan’s latest settled execution on the original card projection.'
    )
  }
  const call = createOrchestrationCaller(runtime)
  let coordinatorHandle = run.coordinator_handle
  const pane = coordinatorHandle ? runtime.getLiveTerminalPaneKey(coordinatorHandle) : null
  if (!coordinatorHandle || !pane || db.getCurrentRunForPane(pane)?.id !== run.id) {
    coordinatorHandle = await createDesktopCoordinator(
      runtime,
      chain.worktreeId,
      'Outcome continuation',
      { launchCause: { trigger: 'outcome', reference: { outcomeChainId: chain.id } } }
    )
    await call('orchestration.runUse', { id: run.id, from: coordinatorHandle })
  }
  if ((await readSessionOutcomePrincipal()) !== set.continuation.principal) {
    throw new Error('Restore the original signed company/person before continuing.')
  }
  let attempt: SessionOutcomeAttempt = {
    ...initial,
    runId: run.id,
    taskId: task.id,
    continuationTaskId: task.hub_task_id!,
    coordinatorHandle,
    nativeContinuation: {
      previousDispatchId,
      worktreeId: chain.worktreeId,
      briefSha256: digest(brief)
    },
    state: 'launching'
  }
  // Persist operation, predecessor and exact launch brief before the existing RPC can start a worker.
  persist(attempt)
  const started = await call<{
    dispatchId: string
    state: string
    lastError?: string
  }>('orchestration.workerStart', {
    task: task.id,
    run: run.id,
    from: coordinatorHandle,
    continueFrom: previousDispatchId,
    worktree: `id:${chain.worktreeId}`,
    agent: action.agent,
    ...(action.model ? { model: action.model } : {}),
    ...(action.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...action.openrouterCandidates] }
      : {}),
    ...(action.effort ? { effort: action.effort } : {}),
    ...(action.accountChoiceId ? { accountChoiceId: action.accountChoiceId } : {}),
    executionBrief: brief,
    timeoutMs: 180_000
  })
  attempt = {
    ...attempt,
    dispatchId: started.dispatchId,
    state: started.state === 'ready' ? 'running' : 'unverifiable',
    updatedAt: Date.now(),
    ...(started.lastError ? { error: started.lastError } : {})
  }
  persist(attempt)
  return attempt
}

/** A lost response is recovered from this operation's actual native launch receipt.
 * Never infer ownership from the latest Task dispatch alone, and never relaunch here. */
export function nativeSessionOutcomeDispatch(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt
) {
  const native = attempt.nativeContinuation
  if (!native || !attempt.taskId || !attempt.runId || !attempt.continuationTaskId) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  const dispatch = attempt.dispatchId
    ? db.getDispatchContextById(attempt.dispatchId)
    : db.getDispatchContext(attempt.taskId)
  const run = db.getRun(attempt.runId)
  if (
    !dispatch ||
    dispatch.id === native.previousDispatchId ||
    dispatch.task_id !== attempt.taskId ||
    dispatch.run_id !== attempt.runId ||
    dispatch.hub_task_id !== attempt.continuationTaskId ||
    run?.origin !== 'local_bound' ||
    run.console_job ||
    run.hub_task_id !== attempt.continuationTaskId
  ) {
    return undefined
  }
  try {
    assertUnboundLocalWorkerStart(db, attempt.taskId)
    const options = JSON.parse(db.getWorkerDispatch(dispatch.id)?.start_options ?? 'null')
    const action = sessionOutcomeAttemptAction(attempt)
    if (
      typeof options?.executionBrief !== 'string' ||
      digest(options.executionBrief) !== native.briefSha256 ||
      options.continueFrom !== native.previousDispatchId ||
      options.worktree !== `id:${native.worktreeId}` ||
      options.resolvedWorktreeId !== native.worktreeId ||
      options.agent !== action.agent ||
      options.accountChoiceId !== (action.accountChoiceId ?? null) ||
      options.launch?.requested?.agent !== action.agent ||
      options.launch?.requested?.model !== (action.model ?? null) ||
      options.launch?.requested?.effort !== (action.effort ?? null) ||
      JSON.stringify(options.launch?.requested?.openrouterCandidates) !==
        JSON.stringify(action.openrouterCandidates)
    ) {
      return undefined
    }
    return dispatch
  } catch {
    return undefined
  }
}
