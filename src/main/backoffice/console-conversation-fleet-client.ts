import {
  validateFleetOmpRoutes,
  validateFleetOmpAdmission
} from './console-fleet-openrouter-preflight'
import { fleetReconciliationAdmission } from './console-fleet-reconciliation'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-api'
import { isDeepStrictEqual } from 'node:util'
import type {
  ConsoleConversationFleetAdmitRequest,
  ConsoleConversationFleetPreview
} from '../../shared/console-conversation-fleet-types'
import type {
  ConsoleWorkflowJson,
  ConsoleWorkflowAdmission
} from '../../shared/console-workflow-types'
import {
  conversationFleetAdmitRequest,
  conversationFleetPreviewRequest
} from '../../shared/console-conversation-fleet-schemas'
import { assertConversationFleetPreview } from '../../shared/conversation-fleet-preview'
import { matchesConversationFleetAdoption } from '../../shared/console-conversation-fleet-adoption'
import { taskRequest } from '../../shared/console-workflow-schemas'
import {
  conversationFleetInventory,
  conversationFleetPreview,
  conversationFleetTaskContext
} from './console-conversation-fleet-responses'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { workflowAdmission } from './console-workflow-responses'
import { matchesConversationFleetSources } from './console-conversation-fleet-source-preview'
import { matchesConversationPersonHandoffs } from './console-conversation-person-handoff-preview'
import { failure, requestConsoleWorkflow as request, validated } from './console-workflow-transport'

type ReviewedPreview = {
  principal: string
  isCurrent(): boolean
  graph: string
  admission: ConsoleConversationFleetPreview['admission']
}
const reviewed = new Map<string, ReviewedPreview>()

function object(value: ConsoleWorkflowJson | undefined): Record<string, ConsoleWorkflowJson> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export const readConsoleConversationFleetInventory: ConsoleWorkflowApi['fleetInventory'] = () =>
  request('/api/gtd/workflow-dispatch-inventory', 'GET', conversationFleetInventory)

export const readConsoleConversationFleetTaskContext: ConsoleWorkflowApi['fleetTaskContext'] = (
  args
) =>
  validated(args, taskRequest, ({ taskId }) =>
    request(
      `/api/gtd/workflow-tasks/${taskId}/context`,
      'GET',
      conversationFleetTaskContext.refine((value) => value.task_id === taskId)
    )
  )

export const previewConsoleConversationFleetTask: ConsoleWorkflowApi['previewFleetTask'] = (args) =>
  validated(args, conversationFleetPreviewRequest, async (body) => {
    if (!isDeepStrictEqual(args, body)) {
      return failure(
        'invalid_request',
        'The workflow inputs must be valid without changing the selected instructions or execution settings.'
      )
    }
    const person = await captureConsoleWorkflowPerson()
    if (!person.ok) {
      return person
    }
    const routes = await validateFleetOmpRoutes(
      body.classification.steps,
      readConsoleConversationFleetInventory
    )
    if (!routes.ok) {
      return routes
    }
    const source = {
      session_ref: body.source.sessionRef,
      ...(body.source.sessionId ? { session_id: body.source.sessionId } : {}),
      ...(body.source.transcriptDigest ? { transcript_digest: body.source.transcriptDigest } : {}),
      ...(body.source.templateId ? { template_id: body.source.templateId } : {}),
      ...(body.source.capturedAt ? { captured_at: body.source.capturedAt } : {})
    }
    const result = await request(
      `/api/gtd/workflow-tasks/${body.taskId}/preview`,
      'POST',
      conversationFleetPreview,
      {
        expected_revision: body.expectedRevision,
        classification: body.classification,
        prompt: body.prompt,
        fanout_ack: body.fanoutAck,
        source,
        ...(body.sourceFiles ? { source_files: body.sourceFiles } : {}),
        ...(body.sourceDeletions ? { source_deletions: body.sourceDeletions } : {}),
        ...(body.sourceSummaryFile ? { source_summary_file: body.sourceSummaryFile } : {})
      },
      30_000,
      true,
      person.data.principal,
      person.data.isCurrent
    )
    if (!result.ok) {
      return result
    }
    if (!person.data.isCurrent()) {
      return failure('connection_changed', 'The signed-in person changed. Preview again.')
    }
    const preview = result.data
    const frozen = object(preview.graph.policy.conversation_dispatch)
    const authority = object(frozen.admission)
    const frozenSource = object(frozen.source)
    try {
      assertConversationFleetPreview(body, preview)
      if (
        preview.admission.task_id !== body.taskId ||
        preview.admission.expected_revision !== body.expectedRevision ||
        preview.filing.company_slug !== body.classification.company_slug ||
        frozen.version !== 1 ||
        frozen.task_id !== body.taskId ||
        frozen.expected_revision !== body.expectedRevision ||
        authority.context_digest !== preview.admission.context_digest ||
        authority.adopt_stage !== preview.admission.adopt_stage ||
        !matchesConversationFleetAdoption(preview.graph, preview.admission.adopt_stage) ||
        Object.keys(frozenSource).length !== Object.keys(source).length ||
        Object.entries(source).some(([key, value]) => frozenSource[key] !== value) ||
        !matchesConversationFleetSources(body, preview.graph) ||
        !matchesConversationPersonHandoffs(body, preview.graph, person.data.clerkUserId) ||
        (!body.fanoutAck &&
          preview.graph.columns.some(
            (column) =>
              preview.graph.nodes.filter(
                (node) => node.actor_type === 'ai' && column.includes(node.key)
              ).length > 1
          ))
      ) {
        throw new Error('Preview changed the dispatch context')
      }
    } catch {
      return failure(
        'invalid_response',
        'The server preview did not preserve the conversation, stages, fleet selection and task context.'
      )
    }
    reviewed.set(preview.digest, {
      principal: person.data.principal,
      isCurrent: person.data.isCurrent,
      graph: JSON.stringify(preview.graph),
      admission: preview.admission
    })
    if (reviewed.size > 64) {
      reviewed.delete(reviewed.keys().next().value!)
    }
    return result
  })

function matchesReviewedAdmission(
  body: ConsoleConversationFleetAdmitRequest,
  preview?: ReviewedPreview
): preview is ReviewedPreview {
  const serializedGraph = JSON.stringify(body.graph)
  return (
    !!preview &&
    preview.isCurrent() &&
    isDeepStrictEqual(JSON.parse(preview.graph), JSON.parse(serializedGraph)) &&
    preview.admission.task_id === body.taskId &&
    preview.admission.expected_revision === body.expectedRevision &&
    preview.admission.context_digest === body.contextDigest &&
    preview.admission.adopt_stage === body.adoptStage
  )
}

export function hasReviewedFleetAdmission(args: unknown): boolean {
  const parsed = conversationFleetAdmitRequest.safeParse(args)
  return parsed.success && matchesReviewedAdmission(parsed.data, reviewed.get(parsed.data.digest))
}

export const admitConsoleConversationFleetTask: ConsoleWorkflowApi['admitFleetTask'] = (args) =>
  admitReviewedFleetTask(args)

/** Only the journal's durably claimed, previously approved request may use this restart path. */
export async function admitRetainedFleetTask(
  args: ConsoleConversationFleetAdmitRequest,
  isCurrent: () => boolean,
  reconcile = false
) {
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  if (!isCurrent()) {
    return failure<ConsoleWorkflowAdmission>('connection_changed', 'The signed-in person changed.')
  }
  return admitReviewedFleetTask(
    args,
    {
      principal: person.data.principal,
      isCurrent: () => isCurrent() && person.data.isCurrent(),
      graph: JSON.stringify(args.graph),
      admission: {
        task_id: args.taskId,
        expected_revision: args.expectedRevision,
        context_digest: args.contextDigest,
        adopt_stage: args.adoptStage
      }
    },
    reconcile
  )
}

const admitReviewedFleetTask = (
  args: ConsoleConversationFleetAdmitRequest,
  retained?: ReviewedPreview,
  reconcile = false
) =>
  validated(args, conversationFleetAdmitRequest, async (body) => {
    const preview = retained ?? reviewed.get(body.digest)
    if (!matchesReviewedAdmission(body, preview)) {
      return failure<ConsoleWorkflowAdmission>(
        'preview_required',
        'Preview this exact fleet workflow with the current signed-in person before dispatching.'
      )
    }
    const eligibility = await validateFleetOmpAdmission(
      body,
      readConsoleConversationFleetInventory,
      preview,
      reconcile
    )
    if (!eligibility.ok) {
      return eligibility
    }
    const response = reconcile ? fleetReconciliationAdmission(body) : workflowAdmission
    return request(
      `/api/gtd/workflow-tasks/${body.taskId}/${reconcile ? 'reconcile' : 'admit'}`,
      'POST',
      response.refine(
        (value) =>
          value.workflow_id === body.graph.dispatch_id &&
          value.jobs.length === body.graph.nodes.length &&
          new Set(value.jobs.map((job) => job.id)).size === value.jobs.length &&
          new Set(value.jobs.map((job) => job.task_id)).size === value.jobs.length &&
          body.graph.nodes.every((node) => {
            const jobs = value.jobs.filter((job) => job.policy.workflow.key === node.key)
            return (
              jobs.length === 1 &&
              jobs[0].policy.workflow.digest === body.digest &&
              jobs[0].policy.workflow.dispatch_id === body.graph.dispatch_id &&
              jobs[0].policy.workflow.mode === body.graph.mode &&
              jobs[0].actor_type === node.actor_type &&
              jobs[0].policy.workflow.actor_type === node.actor_type &&
              jobs[0].policy.workflow.actor_id === node.actor_id &&
              jobs[0].policy.workflow.action === node.action &&
              jobs[0].provider === (node.provider ?? null) &&
              jobs[0].model === (node.model ?? null) &&
              JSON.stringify(jobs[0].policy.workflow.openrouter_candidates) ===
                JSON.stringify(node.openrouter_candidates) &&
              jobs[0].effort === (node.effort ?? null) &&
              jobs[0].repo === (node.repo ?? null) &&
              JSON.stringify(jobs[0].policy.workflow.after_keys) === JSON.stringify(node.after) &&
              (jobs[0].policy.workflow.placement ?? 'fleet') === 'fleet' &&
              (jobs[0].policy.workflow.machine ?? null) === (node.machine ?? null) &&
              isDeepStrictEqual(jobs[0].policy.workflow.workspace, node.workspace) &&
              jobs[0].policy.workflow.base_sha === node.base_sha &&
              isDeepStrictEqual(
                jobs[0].policy.workflow.source,
                object(body.graph.policy.conversation_dispatch).source
              ) &&
              isDeepStrictEqual(
                jobs[0].policy.workflow.source_files ?? [],
                node.source_files ?? []
              ) &&
              isDeepStrictEqual(
                jobs[0].policy.workflow.source_deletions ?? [],
                node.source_deletions ?? []
              ) &&
              jobs[0].policy.workflow.source_overlay === node.source_overlay &&
              isDeepStrictEqual(jobs[0].policy.workflow.person_handoff, node.person_handoff) &&
              isDeepStrictEqual(
                jobs[0].policy.workflow.mechanical_execution,
                node.mechanical_execution && {
                  ...node.mechanical_execution,
                  input: { ...node.mechanical_execution.input, job_id: jobs[0].id }
                }
              ) &&
              isDeepStrictEqual(jobs[0].policy.workflow.handoff_report, node.handoff_report) &&
              isDeepStrictEqual(jobs[0].policy.workflow.output_artifacts, node.output_artifacts) &&
              jobs[0].policy.workflow.source_task_id === body.taskId &&
              (node.key === body.adoptStage
                ? jobs[0].task_id === body.taskId
                : jobs[0].task_id !== body.taskId)
            )
          })
      ),
      {
        graph: body.graph,
        digest: body.digest,
        expected_revision: body.expectedRevision,
        context_digest: body.contextDigest,
        adopt_stage: body.adoptStage
      },
      30_000,
      false,
      preview.principal,
      preview.isCurrent
    )
  })
