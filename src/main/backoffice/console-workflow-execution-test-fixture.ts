import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'

export const executionPrincipal = 'a'.repeat(64)
export const executionBinding = {
  ...consoleJobClaimFixture,
  jobId: 'job_local12345',
  workflowId: 'wf_local12345',
  inputDigest: 'd'.repeat(64)
}
export function executionHandoff() {
  const binding = executionBinding
  return {
    job_id: binding.jobId,
    task_id: binding.taskId,
    title: 'Explicit build',
    brief: 'Implement the exact stored brief.',
    agent_brief: 'Stored provider instructions.',
    acceptance: 'The focused command passes.',
    acceptance_commands: [{ program: 'node', args: ['-e', 'process.exit(0)'], timeout_ms: 1000 }],
    repo: 'omnirogue/test-project',
    base_branch: 'sal',
    base_sha: null as string | null,
    provider: 'codex',
    model: 'gpt-test',
    effort: null,
    owned_paths: ['src/**'],
    checkouts: [],
    actor_type: 'ai',
    placement: 'local',
    status: 'queued',
    canonical_binding: {
      task_id: binding.taskId,
      contract_id: binding.contractId,
      contract_digest: binding.contractDigest,
      contract_generation: binding.contractGeneration
    },
    workflow: {
      workflow_id: binding.workflowId,
      dispatch_id: 'dispatch_server',
      digest: 'f'.repeat(64),
      action: 'execute'
    }
  }
}
export function executionClaimRow() {
  const b = executionBinding
  const c = b.claim!
  return {
    id: b.jobId,
    task_id: b.taskId,
    status: 'running',
    attempt: b.attempt,
    lease_generation: b.leaseGeneration,
    claim_host: c.host,
    claimed_at: c.claimedAt,
    runner_instance: c.runnerInstance,
    claim_request_id: c.claimRequestId,
    cancel_requested: false,
    process_identity: null,
    terminal_proof: null,
    execution_binding: {
      job_id: b.jobId,
      task_id: b.taskId,
      host: c.host,
      attempt: b.attempt,
      claimed_at: c.claimedAt,
      runner_instance: c.runnerInstance,
      claim_request_id: c.claimRequestId,
      attempt_intent_id: c.attemptIntentId,
      dispatch_key: c.dispatchKey,
      contract_id: b.contractId,
      contract_digest: b.contractDigest,
      contract_generation: b.contractGeneration
    }
  }
}
