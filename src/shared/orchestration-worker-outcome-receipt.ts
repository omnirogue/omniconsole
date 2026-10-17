import type { OrchestrationWorkerRouteObservation } from './orchestration-worker-output'

type WorkerRouteSelection = { agent: string | null; model: string | null; effort: string | null }

export type OrchestrationWorkerStartupTiming = {
  source: 'run-home-monotonic'
  from: 'dispatch-create'
  to: 'dispatch-input-accepted'
  durationMs: number
}

export type OrchestrationWorkerCanonicalReportEvidence = {
  source: 'hub-task-lifecycle'
  scope: 'historical_attempt'
  attempt: {
    taskId: string
    attemptId: string
    dispatchKey: string
    contractId: string
    contractDigest: string
    contractGeneration: number
    lifecycleGeneration: number
    claimVersion: number
    authorityEpoch: number
    producingSessionIds: string[]
    nativeExecutionRef: string | null
    candidateGeneration: number
    candidateDigest: string
    evidenceManifestDigest: string
    candidateSubmittedAt: string
    inputDigest: null
    inputDigestProvenance: null
  }
  currentTask: {
    contractId: string
    contractDigest: string
    contractGeneration: number
    lifecycleGeneration: number
    claimVersion: number
    authorityEpoch: number
  }
  reports: {
    reportId: string
    verdict: 'pass' | 'fail' | 'insufficient_evidence'
    reportOrdinal: number
    createdAt: string
    verificationPolicyDigest: string
    verifierSessionId: string
    reviewerLineage: string
    implementerLineage: string
    evidenceIds: string[]
  }[]
}

export type OrchestrationWorkerCurrentAcceptance =
  | { state: 'not_observed' | 'unavailable'; reason: string }
  | {
      state: 'observed'
      source: 'hub-task-lifecycle'
      authorityView: 'canonical_current_task_verifications'
      reportId: string
      verificationPolicyDigest: string
    }

export type OrchestrationWorkerOutcomeReceipt = {
  schemaVersion: 1
  binding: {
    runId: string
    taskId: string
    dispatchId: string
    hubTaskId: string | null
    hubJobId: string | null
    hubAttemptId: string | null
    hubAttempt: number | null
    hubLeaseGeneration: number | null
    hubSessionId: string | null
  }
  status: {
    task: string
    dispatch: string
    worker: string | null
    currentDispatchId: string | null
    isCurrentDispatch: boolean
  }
  route: {
    requested: WorkerRouteSelection | null
    resolved: WorkerRouteSelection | null
    resolvedSource: 'resolved-launch-arguments' | 'legacy-acknowledgement' | null
    actual:
      | (OrchestrationWorkerRouteObservation & { provider: string; sourceIdentity: string })
      | null
    pairedEnvironmentId: string | null
    executionHostClaim: { host: string; source: 'hub-activation-claim' } | null
    accountCategory: null
  }
  recordTimes: {
    runCreatedAt: string | null
    taskCreatedAt: string | null
    taskCompletedAt: string | null
    dispatchCreatedAt: string | null
    dispatchRecordedAt: string | null
    dispatchCompletedAt: string | null
    workerCreatedAt: string | null
    workerUpdatedAt: string | null
  }
  recordIntervals: {
    taskCreatedToDispatchRecordedMs: number | null
    dispatchRecordedToCompletionMs: number | null
  }
  phaseDurations: {
    queueMs: null
    startupMs: number | null
    contextTransferMs: null
    executionMs: null
    retryMs: null
    reviewMs: null
    verificationMs: null
  }
  startupTiming: OrchestrationWorkerStartupTiming | null
  outcome: {
    reportedCompletedAt: string | null
    independentlyAcceptedQuality: null
    acceptanceReason: 'acceptance_not_observed' | 'quality_not_measured'
    currentAcceptance?: OrchestrationWorkerCurrentAcceptance
  }
  hubEvidence:
    | { state: 'not_linked' | 'unavailable'; reason: string }
    | {
        state: 'observed'
        reason: 'canonical_historical_reports_observed'
        canonicalReports: OrchestrationWorkerCanonicalReportEvidence
      }
  providerRead: {
    state: 'not_requested' | 'observed' | 'unavailable'
    reason: string | null
  }
  recordWarnings: string[]
  usage: { inputTokens: null; outputTokens: null; cost: null; currency: null }
}
