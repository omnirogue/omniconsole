import type {
  ConsoleConversationFleetAdmitRequest,
  ConsoleConversationFleetPreviewRequest
} from '../../shared/console-conversation-fleet-types'
import type { ConsoleWorkflowGraph, ConsoleWorkflowJob } from '../../shared/console-workflow-types'
export const taskId = 'btk_fleet1234'
export const source = {
  session_ref: 'conversation-1234',
  transcript_digest: 'd'.repeat(64),
  captured_at: '2026-09-12T16:00:00.000Z'
}
let sequence = 0

export function createConversationFleetClientFixture() {
  const input: ConsoleConversationFleetPreviewRequest = {
    taskId,
    expectedRevision: 7,
    prompt: ' Exact conversation\n',
    fanoutAck: false,
    source: {
      sessionRef: source.session_ref,
      transcriptDigest: source.transcript_digest,
      capturedAt: source.captured_at
    },
    classification: {
      title: 'Review conversation',
      company_slug: 'example',
      execution_mode: 'single_shot',
      steps: [
        {
          key: 'review',
          title: 'Review',
          actor_id: 'codex:gpt-6-astra',
          actor_type: 'ai',
          action: 'review',
          brief: ' Preserve the full instructions\n',
          placement: 'fleet',
          machine: 'mw0003',
          effort: 'high',
          after: [],
          acceptance_commands: [],
          repo: 'Example/project',
          base_branch: 'main',
          base_sha: 'b'.repeat(40)
        }
      ]
    }
  }
  sequence += 1
  const digest = sequence.toString(16).padStart(64, '0')
  const graph: ConsoleWorkflowGraph = {
    schema_version: 1,
    mode: 'single_shot',
    title: input.classification.title,
    prompt: input.prompt,
    company: 'example',
    owner: 'emp_sal',
    dispatch_id: `wf_fleet_${sequence}`,
    digest,
    columns: [['review']],
    policy: {
      conversation_dispatch: {
        version: 1,
        task_id: taskId,
        expected_revision: 7,
        source,
        admission: { context_digest: 'c'.repeat(64), adopt_stage: 'review' }
      }
    },
    nodes: [
      {
        key: 'review',
        title: 'Review',
        brief: `Action: review\n\nPreserve the full instructions\n\nOriginal task:\n${input.prompt}`,
        actor_type: 'ai',
        actor_id: 'codex:gpt-6-astra',
        action: 'review',
        after: [],
        owned_paths: null,
        provider: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
        placement: 'fleet',
        machine: 'mw0003',
        acceptance_commands: [],
        repo: 'Example/project',
        base_branch: 'main',
        base_sha: 'b'.repeat(40)
      }
    ]
  }
  const admittedJob: ConsoleWorkflowJob = {
    id: 'job_fleet1234',
    task_id: taskId,
    node_id: taskId,
    title: 'Review',
    status: 'queued',
    actor_type: 'ai',
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    repo: 'Example/project',
    machine: null,
    pr_url: null,
    attempt: 0,
    lease_generation: 0,
    owned_paths: null,
    updated_at: null,
    policy: {
      workflow: {
        version: 1,
        digest,
        mode: 'single_shot',
        dispatch_id: graph.dispatch_id,
        key: 'review',
        actor_type: 'ai',
        actor_id: 'codex:gpt-6-astra',
        action: 'review',
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: [],
        machine: 'mw0003',
        source,
        source_task_id: taskId,
        base_sha: 'b'.repeat(40)
      }
    },
    blockers: [],
    workflow_state: 'ready',
    can_decide: false
  }
  const admission: ConsoleConversationFleetAdmitRequest = {
    taskId,
    expectedRevision: 7,
    graph,
    digest,
    contextDigest: 'c'.repeat(64),
    adoptStage: 'review'
  }
  return { input, graph, admittedJob, admission }
}
