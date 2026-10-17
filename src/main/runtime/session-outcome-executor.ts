import { sessionOutcomeLaunchNotStarted } from './session-outcome-launch-absence'
import { sessionOutcomeSourceContext } from './session-outcome-source-packet'
import { verifySourcePacketFiles } from './session-outcome-source-packet-files'
import { sessionOutcomeResultMessage } from './session-outcome-result'
import { sessionOutcomeWaitBrief } from './session-outcome-wait-brief'
import {
  launchNativeSessionOutcomeAction,
  nativeSessionOutcomeDispatch
} from './session-outcome-native-continuation'
import {
  assertSessionOutcomeTaskAdmission,
  continueSessionOutcomeTask
} from './session-outcome-task-continuation'
import {
  failedSessionOutcomeAttempt,
  startLocalSessionOutcomeWorker
} from './session-outcome-local-launch'
import type { SessionOutcomeLaunchDetach } from './session-outcome-launch-detach'
import { randomUUID } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeActionKey,
  type SessionOutcomeAction,
  type SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { sessionOutcomeActionStepId } from '../../shared/session-outcome-identity'
import { advanceSameConversationTurn } from './session-outcome-conversation-turn'
import { WorkerStartParams } from './rpc/methods/orchestration-worker-start-schema'
import { agentHookIsAsking, sessionAttemptAwaiting } from './session-outcome-attempt-awaiting'
import {
  SessionOutcomeBriefTooLargeError,
  sessionAttemptFailure,
  workerDispatchFailure
} from './session-outcome-attempt-failure'

export function sessionOutcomeExecutionBrief(
  chain: SessionChain,
  action: SessionOutcomeAction,
  attemptId: string
): string {
  if (action.route === 'same-session') {
    return sessionOutcomeWaitBrief(chain, action)
  }
  const sourceContext = sessionOutcomeSourceContext(chain)
  const brief = [
    action.instruction,
    sourceContext,
    'Committed outcomes (all remain obligations through every handoff):',
    JSON.stringify(
      chain.outcomeSet?.outcomes.map(({ evidence: _evidence, ...outcome }) => outcome)
    ),
    `Launch attempt: ${attemptId}. Do not repeat already receipted external actions.`,
    'Use only the authority in the user instructions. Missing permission or access requires a question; never infer publishing, sending, merging or deployment authority.',
    'Preserve execution host, company, identity, existing file IDs and destination versions. The execution workspace is not an output destination.',
    'This is one execution stage of the original card. Do not complete or reassign the hub task, approve for a person, or treat worker_done as whole-card acceptance. Publish and merge only when this stage has explicit user authority; the requested human handoff remains an obligation.',
    'Follow repository branch protection and deployment preflight/live verification. Report actual evidence using worker_done; agent exit alone never completes an outcome.'
  ].join('\n\n')
  if (!WorkerStartParams.shape.executionBrief.safeParse(brief).success) {
    throw new SessionOutcomeBriefTooLargeError(
      `The full Next launch context is ${brief.length} characters; the worker limit is 100,000. Source report: ${chain.outcomeSet?.continuation.sourcePacket?.summary.length ?? 0}; step instructions and previous reports: ${action.instruction.length}. Save long reports in workspace files and shorten the Next instructions before resuming. No context was truncated.`
    )
  }
  return brief
}

/** The step this action runs, when the plan asked for it to continue the original conversation. */
function sameConversationStep(chain: SessionChain, action: SessionOutcomeAction): boolean {
  // A chat-filed action ("wait for X, then do Y") continues the conversation that asked for it.
  if (action.route === 'same-session') {
    return true
  }
  const stepId = sessionOutcomeActionStepId(action.id)
  return chain.steps.some(
    (step) => step.id === stepId && step.kind !== 'handoff' && step.route === 'same-session'
  )
}

/** Uses the existing orchestration admission/worker launch gates; no renderer is involved. */
export async function launchSessionOutcomeAction(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  outcomeId: string,
  action: SessionOutcomeAction,
  persist: (attempt: SessionOutcomeAttempt) => void,
  detach?: SessionOutcomeLaunchDetach
): Promise<SessionOutcomeAttempt> {
  const now = Date.now()
  let attempt: SessionOutcomeAttempt = {
    id: randomUUID(),
    outcomeId,
    actionId: action.id,
    actionKey: sessionOutcomeActionKey(action),
    outcomeRevision: chain.outcomeSet!.outcomes.find((entry) => entry.id === outcomeId)!.revision,
    // Which plan version asked for this work, so a superseded attempt stays readable as v1's.
    ...(chain.planVersion ? { planVersion: chain.planVersion } : {}),
    state: 'prepared',
    startedAt: now,
    updatedAt: now
  }
  persist(attempt)
  try {
    await verifySourcePacketFiles(chain)
    const brief = sessionOutcomeExecutionBrief(chain, action, attempt.id)
    // WP-4b: a step the person routed `same-session` starts NO worker. Its brief goes into the
    // original conversation through the person's own send door, so the agent that already did the
    // work answers with its own memory of it. Asked before every other branch, because a route is
    // a property of the STEP and the continuation flavours below are properties of the chain.
    if (sameConversationStep(chain, action)) {
      attempt = await advanceSameConversationTurn({
        runtime,
        chain,
        attempt,
        brief: () => brief,
        persist: (updated) => {
          attempt = updated
          persist(updated)
        }
      })
      persist(attempt)
      return attempt
    }
    if (chain.outcomeSet!.continuation.nativeSource) {
      return await launchNativeSessionOutcomeAction(
        runtime,
        chain,
        action,
        attempt,
        brief,
        (updated) => {
          attempt = updated
          persist(updated)
        }
      )
    }
    if (chain.outcomeSet!.continuation.taskId) {
      assertSessionOutcomeTaskAdmission(action)
      attempt = {
        ...attempt,
        state: 'launching',
        continuationTaskId: chain.outcomeSet!.continuation.taskId
      }
      persist(attempt)
      attempt = await continueSessionOutcomeTask(runtime, chain, action, attempt, brief)
      persist(attempt)
      return attempt
    }
    return await startLocalSessionOutcomeWorker({
      runtime,
      chain,
      outcomeId,
      action,
      brief,
      attempt,
      persist,
      detach
    })
  } catch (error) {
    attempt = failedSessionOutcomeAttempt(attempt, error)
    persist(attempt)
    return attempt
  }
}

/**
 * Read one attempt back from its receipts. A stopped attempt records WHY as a code and WHEN
 * (`failure`, `updatedAt`), because the recovery ladder measures its backoff from that moment; an
 * agent asking its person something is alive, so its prompt rides on `awaiting`, never on `error`.
 */
export function observeSessionOutcomeAttempt(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt,
  now = Date.now()
): SessionOutcomeAttempt {
  if (
    attempt.state === 'completed' ||
    attempt.state === 'blocked' ||
    attempt.state === 'retryable'
  ) {
    return attempt
  }
  // Re-reading the same lost contact must not move the clock its grace period is measured from.
  const lostAt = attempt.state === 'unverifiable' ? attempt.updatedAt : now
  const db = runtime.getOrchestrationDb()
  const dispatch = attempt.nativeContinuation
    ? nativeSessionOutcomeDispatch(runtime, attempt)
    : attempt.dispatchId
      ? db.getDispatchContextById(attempt.dispatchId)
      : attempt.taskId
        ? db.getDispatchContext(attempt.taskId)
        : undefined
  if (!dispatch) {
    if (sessionOutcomeLaunchNotStarted(runtime, attempt)) {
      return {
        ...attempt,
        state: 'blocked',
        launchDisposition: 'not-started',
        error: attempt.error ?? 'The local launch failed before a Dispatch was created.',
        failure: attempt.failure ?? sessionAttemptFailure('launch-not-started', now),
        updatedAt: now
      }
    }
    return {
      ...attempt,
      state: 'unverifiable',
      error: 'Launch receipt is unverifiable; the action will not be repeated.',
      updatedAt: lostAt
    }
  }
  const worker = db.getWorkerDispatch(dispatch.id)
  const task = db.getTask(dispatch.task_id)
  const started = { ...attempt, dispatchId: dispatch.id, launchDisposition: 'started' as const }
  if (task?.status === 'completed' && worker?.state === 'succeeded') {
    let resultMessageId: string | undefined
    if (attempt.nativeContinuation) {
      try {
        const result = JSON.parse(task.result ?? 'null')
        if (
          result?.provenance === 'worker_report' &&
          typeof result.messageId === 'string' &&
          sessionOutcomeResultMessage(runtime, started, result.messageId)
        ) {
          resultMessageId = result.messageId
        }
      } catch {
        /* A missing accepted report is not completion evidence. */
      }
      if (!resultMessageId) {
        return {
          ...attempt,
          state: 'unverifiable',
          error: 'The accepted native worker report is unavailable.',
          updatedAt: lostAt
        }
      }
    }
    return {
      ...started,
      state: 'completed',
      ...(resultMessageId ? { resultMessageId } : {}),
      updatedAt: now,
      error: undefined,
      failure: undefined,
      awaiting: undefined
    }
  }
  if (worker?.state === 'failed' || task?.status === 'failed') {
    // A settled worker is a dead worker: the Dispatch proves this launch started and its receipt
    // proves it stopped, which is what lets the recovery ladder start exactly one replacement.
    return {
      ...started,
      state: 'blocked',
      error:
        worker?.last_error ?? 'The action failed. Reconcile its external receipts before retrying.',
      failure: workerDispatchFailure(worker, dispatch, now),
      awaiting: undefined,
      updatedAt: now
    }
  }
  if (worker?.agent_terminal_handle) {
    const hook = runtime.getFreshAgentHookStatusForHandle(worker.agent_terminal_handle)
    if (agentHookIsAsking(hook)) {
      return {
        ...started,
        state: 'running',
        error: undefined,
        awaiting: sessionAttemptAwaiting(hook, attempt.awaiting, dispatch.assignee_pane_key, now)
      }
    }
    if (hook) {
      return { ...started, state: 'running', error: undefined, awaiting: undefined }
    }
  }
  return {
    ...started,
    state: 'unverifiable',
    error: 'Execution is unverifiable; the action will not be repeated.',
    awaiting: undefined,
    updatedAt: lostAt
  }
}
