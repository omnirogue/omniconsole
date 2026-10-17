import { attachConsoleJobStartReceipt, bindConsoleJobDispatch } from './console-job-binding'
import {
  consoleJobClaimFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from './console-job-test-fixture'
import type { OrchestrationDb } from './db'
import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'

export const canonicalReceiptBinding = {
  ...consoleJobClaimFixture,
  claim: consoleJobClaimFixture.claim!,
  contractId: consoleJobClaimFixture.contractId!,
  contractDigest: consoleJobClaimFixture.contractDigest!,
  contractGeneration: consoleJobClaimFixture.contractGeneration!,
  sessionId: 'ses_server',
  attemptId: consoleJobClaimFixture.claim!.attemptIntentId,
  inputDigest: 'd'.repeat(64)
}

export function createCanonicalReceiptDispatch(
  db: OrchestrationDb,
  started: ConsoleJobBinding = canonicalReceiptBinding
) {
  const run = createConsoleJobRun(db, consoleJobClaimFixture)
  const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: run.hub_task_id! })
  const dispatch = createRootDispatch(db, task.id, 'term_worker')
  const original = { runId: run.id, dispatchId: dispatch.id, principal: consoleJobPrincipalFixture }
  bindConsoleJobDispatch(db, { ...original, binding: consoleJobClaimFixture })
  attachConsoleJobStartReceipt(db, { ...original, binding: started })
  return { run, task, dispatch }
}

export function canonicalReceiptLifecycle() {
  const binding = canonicalReceiptBinding
  const contract = {
    contract_id: binding.contractId,
    contract_digest: binding.contractDigest,
    contract_generation: binding.contractGeneration
  }
  const candidate = {
    candidate_generation: 1,
    candidate_digest: 'e'.repeat(64),
    evidence_manifest_digest: 'f'.repeat(64)
  }
  return {
    schema_version: 1,
    contract: 'task-lifecycle.v1',
    degraded: [] as string[],
    task: {
      id: binding.taskId,
      work_schema_version: 1,
      current_contract_id: binding.contractId,
      current_contract_digest: binding.contractDigest,
      current_contract_generation: binding.contractGeneration,
      lifecycle_generation: 1,
      claim_version: 2,
      authority_epoch: 3,
      status: 'verified_complete'
    },
    attempts: [
      {
        id: binding.attemptId,
        source: 'canonical',
        work_schema_version: 1,
        task_id: binding.taskId,
        ...contract,
        ...candidate,
        lifecycle_generation: 1,
        claim_version: 2,
        authority_epoch: 3,
        dispatch_key: binding.claim.dispatchKey,
        native_execution_ref: `foreman:${binding.jobId}:1:${'a'.repeat(64)}`,
        candidate_submitted_at: '2026-09-30T12:00:00Z',
        input_digest: null,
        input_digest_provenance: null,
        stints: [{ session_id: binding.sessionId }]
      }
    ],
    verification: [
      {
        id: 'ver_report1',
        source: 'canonical',
        work_schema_version: 1,
        task_id: binding.taskId,
        attempt_id: binding.attemptId,
        ...contract,
        ...candidate,
        verdict: 'pass',
        verifier: 'session:ses_verifier',
        verifier_session_id: 'ses_verifier',
        verification_policy_digest: 'b'.repeat(64),
        reviewer_lineage: 'session:ses_verifier',
        implementer_lineage: `attempt:${binding.attemptId}`,
        report_ordinal: 1,
        at: '2026-09-30T12:01:00Z',
        evidence_ids: ['ev_verifier1'],
        findings: [{ private: 'unselected-sensitive-findings' }]
      }
    ]
  }
}

export function canonicalReceiptCurrentVerification() {
  return {
    source: 'canonical',
    authority_view: 'canonical_current_task_verifications',
    task_id: canonicalReceiptBinding.taskId,
    contract_id: canonicalReceiptBinding.contractId,
    contract_digest: canonicalReceiptBinding.contractDigest,
    contract_generation: canonicalReceiptBinding.contractGeneration,
    verification_report_id: 'ver_report1',
    attempt_id: canonicalReceiptBinding.attemptId,
    candidate_generation: 1
  }
}
