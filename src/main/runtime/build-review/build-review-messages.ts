import type { OrchestrationMessageSummary } from '../../../shared/orchestration-check-output'
import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import type { WorkerMailboxTarget, WorkerUnitLike } from './build-review-worker-registry'
import { pipelineQuestionFor, setPipelineQuestion } from './build-review-questions'
import {
  parsePayload,
  parseQuestionOptions,
  pushEvent,
  reportFromMessage,
  workerForDispatch,
  workerForTerminal
} from './build-review-pipeline-state'

export type ProcessedMessages = {
  /** Workers whose worker_done arrived in this batch. */
  completed: WorkerUnitLike[]
}

/**
 * Fold one check Delivery into a mailbox target. Pure with respect to the runtime:
 * it only mutates the target's workers and reports which of them finished.
 */
export function applyDeliveryToTarget(
  target: WorkerMailboxTarget,
  messages: OrchestrationMessageSummary[]
): ProcessedMessages {
  const completed: WorkerUnitLike[] = []
  for (const message of messages) {
    const payload = parsePayload(message.payload)
    const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId : undefined
    const worker = dispatchId
      ? target.workerForDispatch(dispatchId)
      : target.workerForTerminal(message.from_handle)
    if (!worker && dispatchId && target.hold) {
      target.hold(dispatchId, message)
      continue
    }
    if (worker && worker.status !== 'running' && worker.status !== 'starting') {
      continue
    }
    const role = worker?.role ?? 'pipeline'
    switch (message.type) {
      case 'worker_done': {
        if (!worker) {
          target.log('info', 'pipeline', `Ignored worker_done from ${message.from_handle}`)
          break
        }
        worker.report = reportFromMessage(message)
        worker.status = worker.report.outcome === 'succeeded' ? 'succeeded' : 'failed'
        // Why: the worker's Dispatch settles on worker_done, and the runtime
        // then refuses replies to its question ("closed because its Dispatch
        // is inactive"). Leaving the question on the card offered a reply box
        // nobody could use (2026-09-07).
        if (target.pendingQuestionFor(worker)) {
          target.log(
            'info',
            worker.role,
            'Open question superseded by worker_done; it can no longer be answered'
          )
          target.setPendingQuestion(worker, null)
        }
        target.log(
          'worker_done',
          worker.role,
          `${worker.role} reported ${worker.report.outcome}: ${worker.report.subject}`
        )
        completed.push(worker)
        break
      }
      case 'question': {
        if (worker) {
          target.setPendingQuestion(worker, {
            messageId: message.id,
            role: worker.role,
            question: message.body || message.subject || '',
            options: parseQuestionOptions(message.payload),
            askedAt: new Date().toISOString()
          })
        }
        target.log('question', role, message.body || message.subject || '(empty question)')
        break
      }
      case 'escalation': {
        target.log(
          'escalation',
          role,
          `${message.subject ?? 'escalation'}${message.body ? `: ${message.body}` : ''}`
        )
        break
      }
      case 'heartbeat': {
        if (worker && worker.status === 'starting') {
          worker.status = 'running'
        }
        target.log(
          'heartbeat',
          role,
          typeof payload.phase === 'string' ? payload.phase : (message.subject ?? 'alive')
        )
        break
      }
      case undefined:
      default: {
        target.log(
          'info',
          role,
          `${message.type ?? 'message'}: ${message.subject ?? ''}${message.body ? ` — ${message.body}` : ''}`
        )
      }
    }
  }
  return { completed }
}

/** The Build + Review pipeline snapshot seen as one mailbox target. */
export function pipelineMailboxTarget(pipeline: BuildReviewPipelineSnapshot): WorkerMailboxTarget {
  return {
    workerForDispatch: (dispatchId) => workerForDispatch(pipeline, dispatchId),
    workerForTerminal: (handle) => workerForTerminal(pipeline, handle),
    pendingQuestionFor: (worker) => pipelineQuestionFor(pipeline, worker),
    setPendingQuestion: (worker, question) => setPipelineQuestion(pipeline, worker, question),
    log: (kind, role, text) =>
      pushEvent(pipeline, kind, role as 'builder' | 'reviewer' | 'pipeline', text)
  }
}

export function applyDeliveryMessages(
  pipeline: BuildReviewPipelineSnapshot,
  messages: OrchestrationMessageSummary[]
): { completed: ('builder' | 'reviewer')[] } {
  const { completed } = applyDeliveryToTarget(pipelineMailboxTarget(pipeline), messages)
  return { completed: completed.map((worker) => worker.role as 'builder' | 'reviewer') }
}
