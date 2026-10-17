import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import type {
  SessionOutcomeWorkflow,
  SessionOutcomeStageReceipt
} from '../../shared/session-outcome-workflow'

/** Mirrors the existing BFF producer0 -> participants1 -> canonical decide1 wire shape. */
export function workflowProofFixture() {
  const bffDigest = 'a'.repeat(64),
    canonicalDigest = 'b'.repeat(64),
    candidate = 'c'.repeat(40)
  const canonicalSeal = {
    workflow_id: 'wf_frozenproof',
    revision_id: 'rev_frozenproof',
    graph_digest: canonicalDigest
  }
  const loop = { stage_key: 'build', branch_group: 'build__loop', producer_key: 'build' }
  const models = ['gpt-5.6-terra', 'gpt-6-astra', 'gpt-5.6-sol']
  const keys = ['build', 'build__loop_r1_p1', 'build__loop_r1_p2', 'build__loop_r1_decide']
  const nodes = keys.map((key, index) => ({
    key,
    title: key,
    brief: 'Authorized exact stage brief',
    actor_type: index === 3 ? 'mechanical' : 'ai',
    actor_id: index === 3 ? 'stop_rule:zero_blockers' : `codex:${models[index]}`,
    action: index === 3 ? 'decide' : index === 0 ? 'execute' : 'review',
    ...(index < 3
      ? { provider: 'codex', model: models[index], effort: 'high', placement: 'local' }
      : {}),
    loop_stage: {
      ...loop,
      role: index === 0 ? 'producer' : index === 3 ? 'decide' : 'participant',
      round: index === 0 ? 0 : 1
    },
    repo: 'https://github.com/omnirogue/fixture.git',
    base_branch: 'main',
    after: index === 0 ? [] : index === 3 ? keys.slice(1, 3) : ['build'],
    owned_paths: null,
    ...(index === 3
      ? {
          mechanical_execution: {
            handler_key: 'workflow.loop.decide',
            handler_digest: 'd'.repeat(64),
            input: {
              branch_group: loop.branch_group,
              stage_key: 'build',
              round: 1,
              participant_node_keys: keys.slice(1, 3),
              closed_node_keys: [],
              open_node_keys: [],
              max_rounds: 1,
              stop: 'zero_blockers',
              kind: 'review'
            }
          }
        }
      : {})
  }))
  const jobs = nodes.map((node, index) => ({
    id: `job_proof${index}`,
    task_id: `btk_child${index}`,
    node_id: node.key,
    actor_type: node.actor_type,
    provider: node.provider ?? null,
    model: node.model ?? null,
    attempt: 1,
    lease_generation: 1,
    status: 'pr_open',
    blockers: [],
    workflow_state: 'done',
    policy: {
      workflow: {
        digest: bffDigest,
        workflow_id: canonicalSeal.workflow_id,
        dispatch_id: canonicalSeal.workflow_id,
        key: node.key,
        action: node.action,
        loop_stage: node.loop_stage,
        hub_projection: {
          ...canonicalSeal,
          satisfied: true,
          verification_report_id: `report_${index}`,
          terminal_loop_resolutions:
            index === 3
              ? [
                  {
                    revision_id: canonicalSeal.revision_id,
                    branch_group: loop.branch_group,
                    selector_node_key: node.key,
                    evidence_id: 'evidence_closed',
                    verification_report_id: 'report_3',
                    decision: 'closed',
                    selected_node_keys: []
                  }
                ]
              : []
        }
      }
    }
  })) as unknown as ConsoleWorkflowJob[]
  const receipts = jobs.slice(0, 3).map((job, index): SessionOutcomeStageReceipt => ({
    jobId: job.id,
    taskId: job.task_id,
    key: job.policy.workflow.key,
    provider: 'codex',
    model: models[index]!,
    verificationReportId: `report_${index}`,
    eventId: index + 1,
    fingerprint: String(index + 1).repeat(64),
    attempt: 1,
    leaseGeneration: 1,
    dispatchId: `ctx_proof${index}`,
    runId: `run_proof${index}`,
    journalCursor: `cursor_${index}`,
    idempotencyKey: String(index + 1).repeat(64),
    candidateSha: candidate,
    branch: 'omni/job_proof0',
    prUrl: 'https://github.com/omnirogue/fixture/pull/123',
    ...(index
      ? { verdict: { verdict: 'agree', blockers: [], gaps: [], notes: `Reviewed ${candidate}` } }
      : {})
  }))
  const workflow = {
    operationId: 'operation',
    definitionSha256: 'e'.repeat(64),
    phase: 'admitted',
    canonicalSeal,
    preview: {
      ok: true,
      digest: bffDigest,
      workflow_id: canonicalSeal.workflow_id,
      graph: {
        schema_version: 1,
        mode: 'sequential',
        title: 'Frozen',
        prompt: 'Original whole outcome',
        company: 'OmniRogue',
        owner: 'emp_sal',
        policy: {},
        nodes,
        columns: [],
        dispatch_id: canonicalSeal.workflow_id,
        digest: bffDigest
      },
      admission: {
        filing_root_task_id: 'btk_root',
        filing_root_expected_revision: 7,
        objective: {
          goal_id: 'goal',
          title: 'Original task',
          desired_result: 'Accepted by Sal',
          acceptance_policy: { full: true },
          verification_policy: { native: true }
        },
        org_unit_id: 'org_actual',
        expected_authority_epoch: 3
      }
    },
    stages: [
      {
        key: 'build',
        outcomeIds: ['build'],
        stepIds: ['producer', 'astra', 'sol'],
        actionIds: [],
        reviewGroupId: 'review'
      }
    ],
    activations: [],
    receipts
  } as unknown as SessionOutcomeWorkflow
  return { workflow, jobs, candidate, bffDigest, canonicalDigest }
}
