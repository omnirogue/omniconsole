import type { SessionChain } from '../../shared/session-chain-types'
import { readWorkerCompletionPolicy } from '../../shared/orchestration-worker-completion-policy'
import type { OrcaRuntimeService } from './omni-runtime'
import type { MessageRow } from './orchestration/types'
import { isEquivalentPaneKey } from './orchestration/db/pane-key-match'
import { sessionOutcomeCoordinatorHandle } from './session-outcome-local-launch'
import { sessionOutcomeResultMessage } from './session-outcome-result'

const lastRecovery = new WeakMap<OrcaRuntimeService, number>()

/** Only the saved parent receipt accepts execution; worker success alone cannot release it. */
export function acceptPersistedOutcomeWorkers(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): void {
  if (chain.hostId !== 'local' || !chain.outcomeSet?.attempts.length) {
    return
  }
  for (const attempt of chain.outcomeSet.attempts) {
    if (
      attempt.state !== 'completed' ||
      attempt.nativeContinuation ||
      attempt.conversationTurn ||
      !attempt.dispatchId ||
      !attempt.taskId ||
      !attempt.runId ||
      !attempt.coordinatorPaneKey ||
      attempt.coordinatorHandle !== sessionOutcomeCoordinatorHandle(chain, attempt)
    ) {
      continue
    }
    try {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(attempt.taskId)
      const report = JSON.parse(task?.result ?? 'null')
      const message =
        report?.provenance === 'worker_report' && typeof report.messageId === 'string'
          ? sessionOutcomeResultMessage(runtime, attempt, report.messageId)
          : undefined
      if (!message || message.read || task?.status !== 'completed') {
        continue
      }
      const run = db.getRun(attempt.runId)
      const worker = db.getWorkerDispatch(attempt.dispatchId)
      if (
        !run ||
        run.legacy ||
        run.hub_task_id ||
        run.console_job ||
        run.coordinator_handle !== attempt.coordinatorHandle ||
        !run.coordinator_pane_key ||
        !isEquivalentPaneKey(run.coordinator_pane_key, attempt.coordinatorPaneKey) ||
        !worker ||
        !readWorkerCompletionPolicy(worker.start_options)
      ) {
        continue
      }
      const delivery = db.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        limit: 32
      })
      // Never consume an unrelated message or a question/approval to get to the final report.
      if (
        !delivery ||
        !delivery.messages.every(
          (entry) => entry.id === message.id || isAttemptHeartbeat(entry, message)
        )
      ) {
        continue
      }
      db.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        deliveryId: delivery.delivery.id
      })
    } catch (error) {
      console.warn('[outcomes] worker result acceptance deferred', attempt.id, error)
    }
  }
}

function isAttemptHeartbeat(heartbeat: MessageRow, result: MessageRow): boolean {
  if (
    heartbeat.type !== 'heartbeat' ||
    heartbeat.run_id !== result.run_id ||
    heartbeat.from_handle !== result.from_handle ||
    heartbeat.sender_pane_key !== result.sender_pane_key
  ) {
    return false
  }
  try {
    const activity = JSON.parse(heartbeat.payload ?? 'null')
    const accepted = JSON.parse(result.payload ?? 'null')
    return activity?.taskId === accepted.taskId && activity?.dispatchId === accepted.dispatchId
  } catch {
    return false
  }
}

/** Covers a crash between the parent's durable save and acknowledgement, including sealed plans. */
export function recoverPersistedOutcomeWorkerAcceptance(
  runtime: OrcaRuntimeService,
  nowMs: number
): void {
  const last = lastRecovery.get(runtime)
  if (last !== undefined && nowMs >= last && nowMs - last < 10_000) {
    return
  }
  lastRecovery.set(runtime, nowMs)
  try {
    for (const chain of runtime.listSessionChains()) {
      acceptPersistedOutcomeWorkers(runtime, chain)
    }
  } catch (error) {
    console.warn('[outcomes] worker acceptance recovery deferred', error)
  }
}
