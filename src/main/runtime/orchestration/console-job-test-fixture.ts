import type { ConsoleJobBinding } from '../../../shared/console-workflow-types'
import { consoleJobActivationReceipt } from './console-job-activation-receipt'
import type { OrchestrationDb } from './db/orchestration-db'

export const consoleJobFixture: ConsoleJobBinding = {
  taskId: 'btk_journal',
  workflowId: 'workflow_journal',
  jobId: 'job_journal',
  attempt: 1,
  leaseGeneration: 3,
  sessionId: 'ses_server',
  attemptId: 'attempt_server'
}
export const consoleJobPrincipalFixture = 'a'.repeat(64)
export const consoleJobDigestFixture = 'd'.repeat(64)

export const consoleJobClaimFixture: ConsoleJobBinding = {
  taskId: consoleJobFixture.taskId,
  workflowId: consoleJobFixture.workflowId,
  jobId: consoleJobFixture.jobId,
  attempt: consoleJobFixture.attempt,
  leaseGeneration: consoleJobFixture.leaseGeneration,
  claim: {
    host: 'local:emp_sal',
    claimedAt: '2026-09-08T00:00:00.123456+00:00',
    runnerInstance: 'orca_worker_00001',
    claimRequestId: 'orca_dispatch_0001',
    attemptIntentId: 'att_intent_1',
    dispatchKey: 'server:dispatch:1'
  },
  contractId: 'contract_server',
  contractDigest: 'c'.repeat(64),
  contractGeneration: 1
}

export function createConsoleJobRun(db: OrchestrationDb, binding = consoleJobFixture) {
  return db.createRun({
    objective: 'Execute admitted content work',
    coordinatorHandle: `term_${binding.jobId}`,
    coordinatorPaneKey: `tab:${binding.jobId}`,
    hubTaskId: binding.taskId,
    consoleJob: binding,
    consoleJobPrincipal: consoleJobPrincipalFixture,
    consoleJobActivation: consoleJobActivationReceipt(binding, consoleJobDigestFixture)
  })
}
