import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'

export const autoAdvanceWorkflowId = 'wf_fixture'
export const autoAdvanceDigest = 'b'.repeat(64)

/** One projection row shaped exactly like the server's workflow read. */
export function autoAdvanceJob(overrides: {
  id: string
  key?: string
  status?: string
  workflowState?: string
  placement?: 'local' | 'fleet'
  actorType?: ConsoleWorkflowJob['actor_type']
  canDecide?: boolean
  blockers?: string[]
  skipped?: string
  workflowId?: string
}): ConsoleWorkflowJob {
  return {
    id: overrides.id,
    task_id: 'btk_localfixture',
    node_id: null,
    title: overrides.key ?? overrides.id,
    status: overrides.status ?? 'queued',
    actor_type: overrides.actorType ?? 'ai',
    provider: 'codex',
    model: 'gpt-6',
    effort: null,
    repo: 'gitlab.example/team/project',
    machine: null,
    pr_url: null,
    attempt: null,
    lease_generation: null,
    owned_paths: null,
    updated_at: null,
    policy: {
      workflow: {
        version: 1,
        digest: autoAdvanceDigest,
        mode: 'sequential',
        dispatch_id: overrides.workflowId ?? autoAdvanceWorkflowId,
        workflow_id: overrides.workflowId ?? autoAdvanceWorkflowId,
        placement: overrides.placement ?? 'local',
        key: overrides.key ?? overrides.id,
        actor_type: overrides.actorType ?? 'ai',
        actor_id: 'emp_audit',
        action: 'execute',
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: [],
        ...(overrides.skipped ? { skipped: overrides.skipped } : {})
      }
    },
    blockers: overrides.blockers ?? [],
    workflow_state: overrides.workflowState ?? 'ready',
    can_decide: overrides.canDecide ?? false
  }
}
