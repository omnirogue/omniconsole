import type {
  SessionOutcomeWorkflow,
  SessionOutcomeStageReceipt
} from '../../shared/session-outcome-workflow'
import type { ConsoleWorkflowGraph } from '../../shared/console-workflow-types'

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
/** A new graph may reference only the authenticated receipt frozen by its task-scoped source bridge. */
export function sessionOutcomeExternalProducer(
  workflow: SessionOutcomeWorkflow,
  node: ConsoleWorkflowGraph['nodes'][number],
  history: SessionOutcomeWorkflow[]
): SessionOutcomeStageReceipt | undefined {
  const ext = node.external_predecessor
  const candidate = object(ext?.candidate),
    seal = object(ext?.canonical_workflow)
  const locator = workflow.predecessorReceipts?.find(
    (entry) => entry.stage_key === node.loop_stage?.stage_key && entry.mode === 'review-source'
  )
  if (
    !ext ||
    !candidate ||
    !seal ||
    !locator ||
    ext.mode !== 'review-source' ||
    ext.job_id !== locator.job_id ||
    ext.receipt_event_id !== locator.receipt_event_id ||
    ext.fingerprint !== locator.fingerprint ||
    ext.root_task_id !== workflow.preview.admission.filing_root_task_id
  ) {
    return
  }
  for (const prior of history) {
    if (
      prior.error ||
      !prior.canonicalSeal ||
      prior.canonicalSeal.revision_id !== seal.revision_id ||
      prior.canonicalSeal.graph_digest !== seal.graph_digest ||
      prior.preview.workflow_id !== seal.workflow_id ||
      prior.preview.admission.filing_root_task_id !== ext.root_task_id
    ) {
      continue
    }
    const receipt = prior.receipts?.find(
      (entry) =>
        entry.jobId === locator.job_id &&
        entry.eventId === locator.receipt_event_id &&
        entry.fingerprint === locator.fingerprint &&
        entry.taskId === ext.task_id &&
        entry.key === ext.producer_key &&
        entry.verificationReportId === ext.verification_report_id &&
        entry.candidateSha === candidate.candidate_sha &&
        entry.branch === candidate.branch &&
        entry.prUrl === candidate.pr_url
    )
    if (receipt) {
      return receipt
    }
  }
  return undefined
}
