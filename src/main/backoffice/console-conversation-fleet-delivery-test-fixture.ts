import type {
  ConsoleConversationFleetPreviewRequest,
  ConsoleConversationFleetAdmitRequest
} from '../../shared/console-conversation-fleet-types'
import {
  CONVERSATION_PERSON_HANDOFF_ACTOR,
  type ConsoleConversationPersonHandoffRequest
} from '../../shared/console-conversation-person-handoff'
import type {
  ConsoleWorkflowGraph,
  ConsoleWorkflowJob,
  ConsoleWorkflowJson
} from '../../shared/console-workflow-types'
import {
  PERSON_HANDOFF_HANDLER_KEY,
  PERSON_HANDOFF_HANDLER_DIGEST
} from '../../shared/console-workflow-mechanical-execution'

export function appendConversationFleetTestDelivery(
  input: ConsoleConversationFleetPreviewRequest,
  graph: ConsoleWorkflowGraph,
  admittedJob: ConsoleWorkflowJob,
  source: Record<string, ConsoleWorkflowJson>,
  taskId: string
): ConsoleWorkflowJob {
  const report = {
    path: 'handoff-result.json' as const,
    format: 'json' as const,
    max_bytes: 50_331_648 as const,
    files: [],
    manifests: ['outputs/manifest.md'],
    outputs: [
      { path: 'outputs/review.md', source: 'response' as const },
      { path: 'outputs/manifest.md', source: 'manifest' as const }
    ]
  }
  input.classification.steps[0].handoff_report = report
  graph.nodes[0].handoff_report = report
  admittedJob.policy.workflow.handoff_report = report
  const person: ConsoleConversationPersonHandoffRequest = {
    version: 1,
    approved: true,
    recipient_employee_id: 'emp_uma',
    task_id: null,
    action: 'review',
    note: 'Review the produced files.',
    include_summary: true,
    deliverables: { kind: 'manifests', manifestPaths: ['outputs/manifest.md'] },
    due_at: '2026-09-15T17:00:00Z',
    source_files: []
  }
  input.classification.execution_mode = 'sequential'
  input.classification.steps.push({
    key: 'deliver',
    title: 'Deliver to Uma',
    brief: 'Deliver selected files.',
    actor_type: 'mechanical',
    actor_id: CONVERSATION_PERSON_HANDOFF_ACTOR,
    action: 'notify',
    placement: 'fleet',
    after: ['review'],
    acceptance_commands: [],
    person_handoff: person
  })
  graph.mode = 'sequential'
  graph.columns.push(['deliver'])
  const frozenPerson = {
    ...person,
    source_files: [],
    participants: {
      director: { employee_id: 'emp_sal', clerk_user_id: 'user_fleet' },
      recipient: { employee_id: 'emp_uma', clerk_user_id: 'user_uma' }
    }
  }
  const execution = {
    handler_key: PERSON_HANDOFF_HANDLER_KEY,
    handler_digest: PERSON_HANDOFF_HANDLER_DIGEST,
    input: { person_handoff: frozenPerson }
  }
  graph.nodes.push({
    key: 'deliver',
    title: 'Deliver to Uma',
    brief: `Action: notify\n\nDeliver selected files.\n\nOriginal task:\n${input.prompt}`,
    actor_type: 'mechanical',
    actor_id: CONVERSATION_PERSON_HANDOFF_ACTOR,
    action: 'notify',
    after: ['review'],
    owned_paths: null,
    placement: 'fleet',
    acceptance_commands: [],
    person_handoff: frozenPerson,
    mechanical_execution: execution
  })
  admittedJob.policy.workflow.mode = 'sequential'
  return {
    ...admittedJob,
    id: 'job_delivery1234',
    task_id: 'btk_delivery1234',
    node_id: 'btk_delivery1234',
    title: 'Deliver to Uma',
    actor_type: 'mechanical',
    provider: null,
    model: null,
    effort: null,
    repo: null,
    policy: {
      workflow: {
        version: 1,
        digest: graph.digest,
        mode: 'sequential',
        dispatch_id: graph.dispatch_id,
        key: 'deliver',
        actor_type: 'mechanical',
        actor_id: CONVERSATION_PERSON_HANDOFF_ACTOR,
        action: 'notify',
        after: [admittedJob.id],
        after_keys: ['review'],
        require_merged: [],
        approval_ancestors: [],
        source,
        source_task_id: taskId,
        person_handoff: frozenPerson,
        mechanical_execution: {
          ...execution,
          input: { ...execution.input, job_id: 'job_delivery1234' }
        }
      }
    },
    workflow_state: 'blocked',
    blockers: [admittedJob.id]
  }
}

export function onlyConversationFleetTestDelivery(
  input: ConsoleConversationFleetPreviewRequest,
  graph: ConsoleWorkflowGraph,
  admittedJob: ConsoleWorkflowJob,
  source: Record<string, ConsoleWorkflowJson>,
  taskId: string,
  admission: ConsoleConversationFleetAdmitRequest
): ConsoleWorkflowJob {
  const delivery = appendConversationFleetTestDelivery(input, graph, admittedJob, source, taskId)
  const step = input.classification.steps[1]
  const node = graph.nodes[1]
  step.after = []
  step.person_handoff = {
    ...step.person_handoff!,
    task_id: taskId,
    include_summary: false,
    deliverables: { kind: 'files', paths: [] },
    source_files: []
  }
  node.after = []
  node.person_handoff = {
    ...step.person_handoff,
    source_files: [],
    participants: node.person_handoff!.participants
  }
  node.mechanical_execution!.input = { person_handoff: node.person_handoff }
  input.classification.steps = [step]
  input.classification.execution_mode = 'single_shot'
  graph.nodes = [node]
  graph.columns = [['deliver']]
  graph.mode = 'single_shot'
  graph.policy = {
    conversation_dispatch: {
      version: 1,
      task_id: taskId,
      expected_revision: 7,
      source,
      admission: { context_digest: 'c'.repeat(64), adopt_stage: null }
    }
  }
  admission.adoptStage = null
  Object.assign(delivery.policy.workflow, {
    mode: 'single_shot',
    after: [],
    after_keys: [],
    person_handoff: node.person_handoff,
    mechanical_execution: {
      ...node.mechanical_execution,
      input: { person_handoff: node.person_handoff, job_id: delivery.id }
    }
  })
  return delivery
}

export function addConversationFleetTestRecipient(
  input: ConsoleConversationFleetPreviewRequest,
  graph: ConsoleWorkflowGraph,
  delivery: ConsoleWorkflowJob
): ConsoleWorkflowJob {
  const step = structuredClone(input.classification.steps[0])
  const node = structuredClone(graph.nodes[0])
  const second = structuredClone(delivery)
  step.key = node.key = second.policy.workflow.key = 'deliver-second'
  step.title = node.title = second.title = 'Deliver to Jordan'
  step.person_handoff!.recipient_employee_id = 'emp_jonah'
  node.person_handoff!.recipient_employee_id = 'emp_jonah'
  node.person_handoff!.participants.recipient = {
    employee_id: 'emp_jonah',
    clerk_user_id: 'user_jordan'
  }
  node.mechanical_execution!.input = { person_handoff: node.person_handoff! }
  second.id = 'job_second1234'
  second.task_id = second.node_id = 'btk_second1234'
  second.policy.workflow.person_handoff = node.person_handoff
  second.policy.workflow.mechanical_execution = {
    ...node.mechanical_execution!,
    input: { person_handoff: node.person_handoff!, job_id: second.id }
  }
  input.classification.execution_mode = graph.mode = 'parallel'
  delivery.policy.workflow.mode = second.policy.workflow.mode = 'parallel'
  input.classification.steps.push(step)
  graph.nodes.push(node)
  graph.columns = [['deliver', 'deliver-second']]
  return second
}
