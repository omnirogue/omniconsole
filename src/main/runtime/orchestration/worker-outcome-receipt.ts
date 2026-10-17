import type {
  OrchestrationWorkerOutcomeReceipt,
  OrchestrationWorkerStartupTiming
} from '../../../shared/orchestration-worker-outcome-receipt'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { getConsoleJobBindingForDispatch } from './console-job-binding'
import type { OrchestrationDb } from './db'
import { exposeUtcTimestamp } from './db/utc-timestamp'
import { OrchestrationError } from './orchestration-error'

function timestamp(value: string | null | undefined): string | null {
  const exposed = exposeUtcTimestamp(value ?? null)
  return exposed && Number.isFinite(Date.parse(exposed)) ? exposed : null
}

function interval(start: string | null, end: string | null): number | null {
  if (!start || !end) {
    return null
  }
  const duration = Date.parse(end) - Date.parse(start)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function selection(value: unknown): OrchestrationWorkerOutcomeReceipt['route']['requested'] {
  if (!value || typeof value !== 'object') {
    return null
  }
  const route = value as Record<string, unknown>
  const field = (key: string) => (typeof route[key] === 'string' ? route[key] : null)
  return { agent: field('agent'), model: field('model'), effort: field('effort') }
}

function readStartOptions(value: string | undefined): {
  options: Record<string, unknown>
  warnings: string[]
} {
  if (value === undefined) {
    return { options: {}, warnings: [] }
  }
  try {
    if (Buffer.byteLength(value, 'utf8') <= 4 * 1024 * 1024) {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { options: parsed as Record<string, unknown>, warnings: [] }
      }
    }
  } catch {
    // Historical launch data cannot establish a route when unreadable.
  }
  return { options: {}, warnings: ['worker_start_options_unreadable'] }
}

function readStartupTiming(value: unknown): OrchestrationWorkerStartupTiming | null {
  const timing = value as Partial<OrchestrationWorkerStartupTiming> | null
  return timing?.source === 'run-home-monotonic' &&
    timing.from === 'dispatch-create' &&
    timing.to === 'dispatch-input-accepted' &&
    typeof timing.durationMs === 'number' &&
    Number.isFinite(timing.durationMs) &&
    timing.durationMs >= 0
    ? { source: timing.source, from: timing.from, to: timing.to, durationMs: timing.durationMs }
    : null
}

/** Join one immutable attempt; task state may already describe a later attempt. */
export function readWorkerOutcomeReceipt(
  db: OrchestrationDb,
  dispatchId: string
): OrchestrationWorkerOutcomeReceipt {
  const dispatch = db.getDispatchContextById(dispatchId)
  const task = dispatch && db.getTask(dispatch.task_id)
  const run = dispatch && db.getRun(dispatch.run_id)
  const worker = db.getWorkerDispatch(dispatchId)
  if (!dispatch) {
    throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
  }
  if (
    !task ||
    !run ||
    task.run_id !== run.id ||
    (task.hub_task_id ?? null) !== (run.hub_task_id ?? null) ||
    (dispatch.hub_task_id ?? null) !== (run.hub_task_id ?? null) ||
    (worker && (worker.hub_task_id ?? null) !== (run.hub_task_id ?? null))
  ) {
    throw new OrchestrationError('invalid_argument', 'The receipt Run, Task and Dispatch differ.')
  }
  const binding = getConsoleJobBindingForDispatch(db, dispatchId)
  const latest = db.getDispatchContext(task.id)
  const { options, warnings } = readStartOptions(worker?.start_options)
  const startupTiming = readStartupTiming(options.startupTiming)
  const launch = options.launch as
    | { requested?: unknown; effective?: unknown; effectiveSource?: unknown }
    | undefined
  const dispatchRecordedAt = timestamp(dispatch.dispatched_at)
  const dispatchCompletedAt = timestamp(dispatch.completed_at)
  const taskCreatedAt = timestamp(task.created_at)
  return {
    schemaVersion: 1,
    binding: {
      runId: run.id,
      taskId: task.id,
      dispatchId,
      hubTaskId: run.hub_task_id ?? null,
      hubJobId: binding?.jobId ?? null,
      hubAttemptId: binding?.attemptId ?? null,
      hubAttempt: binding?.attempt ?? null,
      hubLeaseGeneration: binding?.leaseGeneration ?? null,
      hubSessionId: binding?.sessionId ?? null
    },
    status: {
      task: task.status,
      dispatch: dispatch.status,
      worker: worker?.state ?? null,
      currentDispatchId: latest?.id ?? null,
      isCurrentDispatch: latest?.id === dispatchId
    },
    route: {
      requested: selection(launch?.requested),
      resolved: selection(launch?.effective),
      resolvedSource: launch
        ? launch.effectiveSource === 'resolved-launch-arguments'
          ? 'resolved-launch-arguments'
          : 'legacy-acknowledgement'
        : null,
      actual: null,
      pairedEnvironmentId: db.getFederatedDispatch(dispatchId)?.environment_id ?? null,
      executionHostClaim: binding?.claim
        ? { host: binding.claim.host, source: 'hub-activation-claim' }
        : null,
      accountCategory: null
    },
    recordTimes: {
      runCreatedAt: timestamp(run.created_at),
      taskCreatedAt,
      taskCompletedAt: timestamp(task.completed_at),
      dispatchCreatedAt: timestamp(dispatch.created_at),
      dispatchRecordedAt,
      dispatchCompletedAt,
      workerCreatedAt: timestamp(worker?.created_at),
      workerUpdatedAt: timestamp(worker?.updated_at)
    },
    recordIntervals: {
      taskCreatedToDispatchRecordedMs: interval(taskCreatedAt, dispatchRecordedAt),
      dispatchRecordedToCompletionMs: interval(dispatchRecordedAt, dispatchCompletedAt)
    },
    phaseDurations: {
      queueMs: null,
      startupMs: startupTiming?.durationMs ?? null,
      contextTransferMs: null,
      executionMs: null,
      retryMs: null,
      reviewMs: null,
      verificationMs: null
    },
    startupTiming,
    outcome: {
      reportedCompletedAt: dispatch.status === 'completed' ? dispatchCompletedAt : null,
      independentlyAcceptedQuality: null,
      acceptanceReason: 'acceptance_not_observed',
      currentAcceptance: {
        state: run.hub_task_id ? 'unavailable' : 'not_observed',
        reason: run.hub_task_id
          ? 'canonical_current_verification_unavailable'
          : 'no_hub_task_binding'
      }
    },
    hubEvidence: {
      state: run.hub_task_id ? 'unavailable' : 'not_linked',
      reason: run.hub_task_id ? 'read_only_attempt_evidence_unavailable' : 'no_hub_task_binding'
    },
    providerRead: { state: 'not_requested', reason: null },
    recordWarnings: warnings,
    usage: { inputTokens: null, outputTokens: null, cost: null, currency: null }
  }
}

export function attachWorkerReceiptProviderObservation(
  receipt: OrchestrationWorkerOutcomeReceipt,
  output: OrchestrationWorkerReadResult
): void {
  if (output.dispatchId !== receipt.binding.dispatchId) {
    throw new OrchestrationError('invalid_argument', 'The provider receipt binding differs.')
  }
  const observation = output.source === 'transcript' ? output.routeObservation : null
  if (
    output.source !== 'transcript' ||
    !observation ||
    observation.source !== 'provider-transcript' ||
    typeof observation.model !== 'string' ||
    !observation.model ||
    (observation.effort !== null && typeof observation.effort !== 'string') ||
    (observation.observedAt !== null &&
      (!Number.isFinite(observation.observedAt) || observation.observedAt < 0)) ||
    typeof output.sourceIdentity !== 'string' ||
    !output.sourceIdentity ||
    typeof output.provider !== 'string'
  ) {
    receipt.providerRead = { state: 'unavailable', reason: 'provider_route_not_observed' }
    return
  }
  receipt.route.actual = {
    ...observation,
    provider: output.provider,
    sourceIdentity: output.sourceIdentity
  }
  receipt.providerRead = { state: 'observed', reason: null }
}
