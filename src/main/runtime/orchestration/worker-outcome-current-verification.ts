import { z } from 'zod'
import type {
  OrchestrationWorkerCanonicalReportEvidence,
  OrchestrationWorkerCurrentAcceptance
} from '../../../shared/orchestration-worker-outcome-receipt'

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const selectorContract = z.object({
  source: z.literal('canonical'),
  authority_view: z.literal('canonical_current_task_verifications'),
  task_id: identifier,
  contract_id: identifier,
  contract_digest: z.string().regex(/^[a-f0-9]{64}$/),
  contract_generation: generation,
  verification_report_id: identifier,
  attempt_id: identifier,
  candidate_generation: generation
})

export function readWorkerReceiptCurrentAcceptance(
  value: unknown,
  degraded: string[],
  evidence: OrchestrationWorkerCanonicalReportEvidence
): OrchestrationWorkerCurrentAcceptance {
  if (degraded.includes('current_verification')) {
    return { state: 'unavailable', reason: 'canonical_current_verification_degraded' }
  }
  if (value === undefined) {
    return { state: 'unavailable', reason: 'canonical_current_verification_unavailable' }
  }
  if (value === null) {
    return { state: 'not_observed', reason: 'canonical_current_verification_absent' }
  }
  const decoded = selectorContract.safeParse(value)
  if (!decoded.success) {
    return { state: 'unavailable', reason: 'canonical_current_verification_contract_unavailable' }
  }
  const selector = decoded.data
  const { attempt, currentTask, reports } = evidence
  const selected = reports.filter((report) => report.reportId === selector.verification_report_id)
  const report = selected.length === 1 ? selected[0] : null
  if (
    selector.task_id !== attempt.taskId ||
    selector.attempt_id !== attempt.attemptId ||
    selector.contract_id !== attempt.contractId ||
    selector.contract_digest !== attempt.contractDigest ||
    selector.contract_generation !== attempt.contractGeneration ||
    selector.candidate_generation !== attempt.candidateGeneration ||
    selector.contract_id !== currentTask.contractId ||
    selector.contract_digest !== currentTask.contractDigest ||
    selector.contract_generation !== currentTask.contractGeneration ||
    !report ||
    report.verdict !== 'pass'
  ) {
    return { state: 'unavailable', reason: 'canonical_current_verification_binding_mismatch' }
  }
  // Why: HUB's view owns effective policy selection; a historical pass cannot replace it.
  return {
    state: 'observed',
    source: 'hub-task-lifecycle',
    authorityView: 'canonical_current_task_verifications',
    reportId: report.reportId,
    verificationPolicyDigest: report.verificationPolicyDigest
  }
}
