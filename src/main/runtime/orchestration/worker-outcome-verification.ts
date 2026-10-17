import { z } from 'zod'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import type { OrchestrationWorkerOutcomeReceipt } from '../../../shared/orchestration-worker-outcome-receipt'
import { readWorkerReceiptCurrentAcceptance } from './worker-outcome-current-verification'

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const fence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sessionId = z.string().regex(/^ses_[A-Za-z0-9_-]{1,128}$/)
const instant = z.string().max(128).datetime({ offset: true })
const contractFields = {
  contract_id: identifier,
  contract_digest: digest,
  contract_generation: generation
}
const candidateFields = {
  candidate_generation: generation,
  candidate_digest: digest,
  evidence_manifest_digest: digest
}
const lifecycle = z.object({
  schema_version: z.literal(1),
  contract: z.literal('task-lifecycle.v1'),
  degraded: z.array(z.string().max(128)).max(64),
  task: z.object({
    id: identifier,
    work_schema_version: z.literal(1),
    current_contract_id: identifier,
    current_contract_digest: digest,
    current_contract_generation: generation,
    lifecycle_generation: generation,
    claim_version: fence,
    authority_epoch: fence
  }),
  attempts: z.array(z.unknown()).max(512),
  verification: z.array(z.unknown()).max(512),
  current_verification: z.unknown().optional()
})
const attemptContract = z.object({
  id: identifier,
  source: z.literal('canonical'),
  work_schema_version: z.literal(1),
  task_id: identifier,
  ...contractFields,
  ...candidateFields,
  lifecycle_generation: generation,
  claim_version: fence,
  authority_epoch: fence,
  dispatch_key: identifier,
  native_execution_ref: identifier.nullable(),
  candidate_submitted_at: instant,
  stints: z
    .array(z.object({ session_id: sessionId }))
    .min(1)
    .max(256)
})
const reportContract = z.object({
  id: identifier,
  source: z.literal('canonical'),
  work_schema_version: z.literal(1),
  task_id: identifier,
  attempt_id: identifier,
  ...contractFields,
  ...candidateFields,
  verdict: z.enum(['pass', 'fail', 'insufficient_evidence']),
  verifier: identifier,
  verifier_session_id: sessionId,
  verification_policy_digest: digest,
  reviewer_lineage: identifier,
  implementer_lineage: identifier,
  report_ordinal: generation,
  at: instant,
  evidence_ids: z.array(identifier).min(1).max(256)
})

type CompleteBinding = ConsoleJobBinding & {
  claim: NonNullable<ConsoleJobBinding['claim']>
  attemptId: string
  sessionId: string
  contractId: string
  contractDigest: string
  contractGeneration: number
}

export function hasWorkerReceiptCanonicalBinding(
  receipt: OrchestrationWorkerOutcomeReceipt,
  binding: ConsoleJobBinding | null
): binding is CompleteBinding {
  return !!(
    binding?.claim &&
    binding.attemptId &&
    binding.sessionId &&
    binding.contractId &&
    binding.contractDigest &&
    binding.contractGeneration &&
    binding.taskId === receipt.binding.hubTaskId &&
    binding.jobId === receipt.binding.hubJobId &&
    binding.attempt === receipt.binding.hubAttempt &&
    binding.leaseGeneration === receipt.binding.hubLeaseGeneration &&
    binding.attemptId === receipt.binding.hubAttemptId &&
    binding.sessionId === receipt.binding.hubSessionId &&
    binding.attemptId === binding.claim.attemptIntentId
  )
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined
}

export function attachWorkerReceiptCanonicalReports(
  receipt: OrchestrationWorkerOutcomeReceipt,
  binding: ConsoleJobBinding | null,
  value: unknown
): void {
  receipt.outcome.acceptanceReason = 'acceptance_not_observed'
  const unavailable = (reason: string) => {
    receipt.hubEvidence = { state: 'unavailable', reason }
    receipt.outcome.currentAcceptance = { state: 'unavailable', reason }
  }
  if (!hasWorkerReceiptCanonicalBinding(receipt, binding)) {
    return unavailable('canonical_attempt_binding_unavailable')
  }
  const decoded = lifecycle.safeParse(value)
  if (!decoded.success || decoded.data.task.id !== binding.taskId) {
    return unavailable('canonical_lifecycle_contract_unavailable')
  }
  const data = decoded.data
  if (data.degraded.some((section) => ['attempts', 'verification', 'evidence'].includes(section))) {
    return unavailable('canonical_report_projection_degraded')
  }
  const attempts = data.attempts.filter((row) => field(row, 'id') === binding.attemptId)
  const selected = attempts.length === 1 ? attemptContract.safeParse(attempts[0]) : null
  if (!selected?.success) {
    return unavailable('canonical_attempt_contract_unavailable')
  }
  const attempt = selected.data
  const producers = attempt.stints.map((stint) => stint.session_id)
  if (
    attempt.task_id !== binding.taskId ||
    attempt.dispatch_key !== binding.claim.dispatchKey ||
    attempt.contract_id !== binding.contractId ||
    attempt.contract_digest !== binding.contractDigest ||
    attempt.contract_generation !== binding.contractGeneration ||
    !producers.includes(binding.sessionId)
  ) {
    return unavailable('canonical_attempt_binding_mismatch')
  }
  const rows = data.verification.filter((row) => field(row, 'attempt_id') === binding.attemptId)
  if (rows.length === 0) {
    return unavailable('canonical_reports_unavailable')
  }
  if (rows.length > 32) {
    return unavailable('canonical_report_limit_exceeded')
  }
  const reports = z.array(reportContract).safeParse(rows)
  if (!reports.success) {
    return unavailable('canonical_report_contract_unavailable')
  }
  const ordered = reports.data.sort((a, b) => a.report_ordinal - b.report_ordinal)
  if (
    ordered.some(
      (report, index) =>
        report.task_id !== attempt.task_id ||
        report.contract_id !== attempt.contract_id ||
        report.contract_digest !== attempt.contract_digest ||
        report.contract_generation !== attempt.contract_generation ||
        report.candidate_generation !== attempt.candidate_generation ||
        report.candidate_digest !== attempt.candidate_digest ||
        report.evidence_manifest_digest !== attempt.evidence_manifest_digest ||
        report.report_ordinal !== index + 1 ||
        report.verifier !== `session:${report.verifier_session_id}` ||
        report.reviewer_lineage !== `session:${report.verifier_session_id}` ||
        report.implementer_lineage !== `attempt:${attempt.id}` ||
        producers.includes(report.verifier_session_id) ||
        Date.parse(report.at) < Date.parse(attempt.candidate_submitted_at)
    )
  ) {
    return unavailable('canonical_report_binding_mismatch')
  }
  receipt.hubEvidence = {
    state: 'observed',
    reason: 'canonical_historical_reports_observed',
    canonicalReports: {
      source: 'hub-task-lifecycle',
      scope: 'historical_attempt',
      attempt: {
        taskId: attempt.task_id,
        attemptId: attempt.id,
        dispatchKey: attempt.dispatch_key,
        contractId: attempt.contract_id,
        contractDigest: attempt.contract_digest,
        contractGeneration: attempt.contract_generation,
        lifecycleGeneration: attempt.lifecycle_generation,
        claimVersion: attempt.claim_version,
        authorityEpoch: attempt.authority_epoch,
        producingSessionIds: producers,
        nativeExecutionRef: attempt.native_execution_ref,
        candidateGeneration: attempt.candidate_generation,
        candidateDigest: attempt.candidate_digest,
        evidenceManifestDigest: attempt.evidence_manifest_digest,
        candidateSubmittedAt: attempt.candidate_submitted_at,
        inputDigest: null,
        inputDigestProvenance: null
      },
      currentTask: {
        contractId: data.task.current_contract_id,
        contractDigest: data.task.current_contract_digest,
        contractGeneration: data.task.current_contract_generation,
        lifecycleGeneration: data.task.lifecycle_generation,
        claimVersion: data.task.claim_version,
        authorityEpoch: data.task.authority_epoch
      },
      reports: ordered.map((report) => ({
        reportId: report.id,
        verdict: report.verdict,
        reportOrdinal: report.report_ordinal,
        createdAt: report.at,
        verificationPolicyDigest: report.verification_policy_digest,
        verifierSessionId: report.verifier_session_id,
        reviewerLineage: report.reviewer_lineage,
        implementerLineage: report.implementer_lineage,
        evidenceIds: report.evidence_ids
      }))
    }
  }
  receipt.outcome.currentAcceptance = readWorkerReceiptCurrentAcceptance(
    data.current_verification,
    data.degraded,
    receipt.hubEvidence.canonicalReports
  )
  if (receipt.outcome.currentAcceptance.state === 'observed') {
    receipt.outcome.acceptanceReason = 'quality_not_measured'
  }
}
