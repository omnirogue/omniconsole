import type { ConsoleWorkflowApi } from '../../shared/console-workflow-api'
import {
  isSequentialConsoleWorkflow,
  taskAdmitRequest,
  taskPreviewRequest
} from '../../shared/console-workflow-task-admission-schemas'
import type { ConsoleTaskPreviewRequest } from '../../shared/console-workflow-task-types'
import type { ConsoleWorkflowPreview } from '../../shared/console-workflow-types'
import { workflowAdmission, workflowPreview } from './console-workflow-responses'
import { taskDetail } from './console-workflow-records'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  failure,
  requestConsoleWorkflow as request,
  unavailable,
  validated
} from './console-workflow-transport'

function matchesRequestedExecution(
  input: ConsoleTaskPreviewRequest,
  preview: ConsoleWorkflowPreview
): boolean {
  const seen = new Set<string>()
  const matched = preview.graph.nodes.every((node) => {
    const step = input.classification.steps.find(
      (candidate) => candidate.key === node.key || candidate.key === node.loop?.key
    )
    if (
      !step ||
      (!step.loop && (node.actor_type !== step.actor_type || node.action !== step.action))
    ) {
      return false
    }
    seen.add(step.key!)
    if (node.actor_type !== 'ai') {
      return true
    }
    if (node.placement !== (step.placement ?? input.placement)) {
      return false
    }
    const expected = node.loop?.role === 'review' ? [] : (step.acceptance_commands ?? [])
    return (
      node.acceptance_commands !== undefined &&
      JSON.stringify(node.acceptance_commands) ===
        JSON.stringify(expected.map((command) => ({ ...command, program: command.program.trim() })))
    )
  })
  return matched && input.classification.steps.every((step) => seen.has(step.key!))
}

export const previewConsoleTask: ConsoleWorkflowApi['previewTask'] = (args) =>
  validated(args, taskPreviewRequest, async (body) => {
    if (body.templateId || body.presetId) {
      return unavailable('applying a server template or preset to task preview')
    }
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    const task = await request(
      `/api/gtd/hub/api/board/${body.taskId}`,
      'GET',
      taskDetail.refine((value) => value.id === body.taskId),
      undefined,
      15_000,
      false,
      person.data.principal
    )
    if (!task.ok) {
      return task
    }
    if (task.data.state_revision !== body.expectedRevision) {
      return failure(
        'stale_revision',
        'The task revision changed. Refresh it and preview again.',
        409
      )
    }
    const classification = {
      ...body.classification,
      steps: body.classification.steps.map((step) =>
        step.actor_type === 'ai' ? { ...step, placement: step.placement ?? body.placement } : step
      )
    }
    if (!person.data.isCurrent()) {
      return failure('connection_changed', 'The signed-in person changed. Preview again.')
    }
    const result = await request(
      '/api/gtd/workflow-graphs/preview',
      'POST',
      workflowPreview,
      { classification, prompt: body.prompt },
      15_000,
      true,
      person.data.principal
    )
    if (!result.ok) {
      return result
    }
    return isSequentialConsoleWorkflow(result.data.graph) &&
      matchesRequestedExecution(body, result.data)
      ? result
      : failure(
          'invalid_response',
          'The server preview did not preserve sequential stages, placement and acceptance commands.'
        )
  })

export const admitConsoleTask: ConsoleWorkflowApi['admitTask'] = (args) =>
  validated(args, taskAdmitRequest, (body) =>
    request(
      '/api/gtd/workflow-graphs/admit',
      'POST',
      workflowAdmission.refine(
        (value) =>
          value.workflow_id === body.graph.dispatch_id &&
          value.jobs.length === body.graph.nodes.length &&
          body.graph.nodes.every((node) => {
            const jobs = value.jobs.filter((job) => job.policy.workflow.key === node.key)
            return (
              jobs.length === 1 &&
              jobs[0].policy.workflow.digest === body.digest &&
              jobs[0].policy.workflow.dispatch_id === body.graph.dispatch_id &&
              (node.key !== body.adoptStage || jobs[0].task_id === body.taskId)
            )
          })
      ),
      {
        graph: body.graph,
        digest: body.digest,
        card_id: body.taskId,
        expected_revision: body.expectedRevision,
        adopt_stage: body.adoptStage,
        objective: body.objective,
        org_unit_id: body.orgUnitId,
        expected_authority_epoch: body.expectedAuthorityEpoch
      }
    )
  )
