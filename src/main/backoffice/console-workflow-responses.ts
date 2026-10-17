import { openrouterCandidates } from '../../shared/openrouter-route'
import type { ConsoleHandoffQuestionDecision } from '../../shared/console-handoff-question'
import { sessionOutcomeCurrentSource } from '../../shared/session-outcome-current-inputs'
import { z } from 'zod'
import {
  conversationHandoffReport,
  conversationHandoffOutput
} from '../../shared/console-conversation-handoff-report'
import {
  consoleJobArtifactReceipt,
  consolePersonHandoffStatus,
  consolePersonHandoffDelivery
} from '../../shared/console-job-results'
import { conversationPersonHandoff } from '../../shared/console-conversation-person-handoff'
import {
  consoleConversationSourceFile,
  consoleConversationSourcePath
} from '../../shared/console-conversation-source-files'
import {
  consoleWorkflowJson,
  jobId,
  workflowAction,
  workflowActor,
  workflowGraph,
  workflowId,
  workflowMode,
  workflowMechanicalExecution,
  workflowNodeWorkspace,
  taskId
} from '../../shared/console-workflow-schemas'
import type {
  ConsoleWorkflowCancellation,
  ConsoleWorkflowJobControl
} from '../../shared/console-workflow-control-types'
import type {
  ConsoleWorkflowAdmission,
  ConsoleWorkflowDecision,
  ConsoleWorkflowJob,
  ConsoleWorkflowPreview,
  ConsoleWorkflowProgress,
  ConsoleWorkflowTemplate,
  ConsoleDecisionsBulkDismiss
} from '../../shared/console-workflow-types'

const nullableText = z.string().nullable()
const jsonObject = z.record(z.string(), consoleWorkflowJson)
export const workflowPolicy = z.object({
  version: z.literal(1),
  digest: z.string(),
  mode: workflowMode,
  dispatch_id: workflowId,
  workflow_id: workflowId.optional(),
  placement: z.enum(['local', 'fleet']).optional(),
  key: z.string(),
  actor_type: workflowActor,
  actor_id: z.string(),
  openrouter_candidates: openrouterCandidates.optional(),
  action: workflowAction,
  after: z.array(z.string()),
  after_keys: z.array(z.string()),
  require_merged: z.array(z.string()),
  require_merged_keys: z.array(z.string()).optional(),
  approval_ancestors: z.array(z.string()),
  loop: jsonObject.optional(),
  loop_stage: jsonObject.optional(),
  current_source: sessionOutcomeCurrentSource.optional(),
  hub_projection: jsonObject.optional(),
  owned_paths: z.array(z.string()).optional(),
  skipped: z.string().optional(),
  machine: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
    .optional(),
  workspace: workflowNodeWorkspace.optional(),
  base_sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  source: jsonObject.optional(),
  source_task_id: taskId.optional(),
  source_files: z.array(consoleConversationSourceFile).max(32).optional(),
  source_deletions: z.array(consoleConversationSourcePath).max(256).optional(),
  source_overlay: z.boolean().optional(),
  person_handoff: conversationPersonHandoff.optional(),
  mechanical_execution: workflowMechanicalExecution.optional(),
  handoff_report: conversationHandoffReport.optional(),
  output_artifacts: z.array(conversationHandoffOutput).max(32).optional()
})
export const workflowJob: z.ZodType<ConsoleWorkflowJob> = z.object({
  id: jobId,
  task_id: z.string().min(1),
  node_id: nullableText,
  title: z.string(),
  status: z.string(),
  actor_type: workflowActor,
  provider: nullableText,
  model: nullableText,
  effort: nullableText,
  repo: nullableText,
  machine: nullableText,
  pr_url: nullableText,
  attempt: z.number().int().nonnegative().nullable(),
  lease_generation: z.number().int().nonnegative().nullable(),
  owned_paths: z.array(z.string()).nullable(),
  updated_at: nullableText,
  execution_artifacts: z.array(consoleJobArtifactReceipt).max(1).optional(),
  policy: z.object({
    workflow: workflowPolicy,
    human_result: jsonObject.optional(),
    person_handoff_delivery: consolePersonHandoffDelivery.optional(),
    person_handoff_status: consolePersonHandoffStatus.optional()
  }),
  blockers: z.array(z.string()),
  workflow_state: z.string(),
  can_decide: z.boolean()
})
export const workflowPreview: z.ZodType<ConsoleWorkflowPreview> = z
  .object({
    ok: z.literal(true),
    graph: workflowGraph,
    digest: z.string(),
    workflow_id: workflowId,
    jobs: z.array(workflowJob)
  })
  .refine(
    (value) => value.digest === value.graph.digest && value.workflow_id === value.graph.dispatch_id
  )
export const workflowProgress: z.ZodType<ConsoleWorkflowProgress> = z.object({
  ok: z.literal(true),
  workflow_id: workflowId,
  jobs: z.array(workflowJob)
})
export const workflowAdmission: z.ZodType<ConsoleWorkflowAdmission> = z.object({
  ok: z.literal(true),
  workflow_id: workflowId,
  receipt: consoleWorkflowJson,
  jobs: z.array(workflowJob)
})
export const workflowDecision: z.ZodType<ConsoleWorkflowDecision> = z.object({
  ok: z.literal(true),
  job: workflowJob,
  duplicate: z.boolean().optional(),
  hub: consoleWorkflowJson.optional()
})
export const workflowCancellation: z.ZodType<ConsoleWorkflowCancellation> = z.object({
  ok: z.literal(true),
  workflow_id: workflowId,
  jobs: z.array(workflowJob),
  cancelled: z.array(jobId),
  cancel_requested: z.array(jobId),
  already_cancelled: z.array(jobId),
  finished: z.array(jobId),
  refused: z.array(z.object({ job_id: jobId, code: z.string(), message: z.string() }))
})
export const workflowJobControl: z.ZodType<ConsoleWorkflowJobControl> = z.object({
  ok: z.literal(true),
  job: z.object({ id: jobId, status: z.string() }),
  cancel_requested: z.boolean().optional(),
  already_cancelled: z.boolean().optional()
})
export const humanActions = z.object({ ok: z.literal(true), jobs: z.array(workflowJob) })
const count = z.number().int().nonnegative()
/** The hub's answer to a decide: the question's id and the state it moved to. */
export const handoffQuestionDecision: z.ZodType<ConsoleHandoffQuestionDecision> = z
  .object({ id: z.string(), status: z.string() })
  .passthrough()
export const decisionsBulkDismiss: z.ZodType<ConsoleDecisionsBulkDismiss> = z
  .object({
    matched: count,
    dismissed: count,
    by_class: z.record(z.string(), count),
    dry_run: z.boolean()
  })
  .passthrough()
export const workflowClassification = z
  .object({
    ok: z.literal(true),
    source: z.enum(['model', 'heuristic']),
    classification: jsonObject.optional(),
    classifications: z.array(jsonObject).optional(),
    mentions: consoleWorkflowJson.optional(),
    engine: z.string().optional(),
    model: z.string().optional(),
    gogap_preview: consoleWorkflowJson.optional()
  })
  .refine((value) => (value.classification === undefined) !== (value.classifications === undefined))

export const workflowTemplates: z.ZodType<ConsoleWorkflowTemplate[]> = z
  .union([
    z.array(jsonObject),
    z.object({ templates: z.array(jsonObject) }).transform((value) => value.templates)
  ])
  .transform((rows) =>
    rows.map((row) => {
      const body =
        row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : null
      return {
        id: row.id,
        name: row.name,
        scope: row.scope ?? null,
        status: row.status ?? null,
        version: typeof row.version === 'string' ? row.version : null,
        description: typeof body?.description === 'string' ? body.description : null
      }
    })
  )
  .pipe(
    z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        scope: nullableText,
        status: nullableText,
        version: nullableText,
        description: nullableText
      })
    )
  )
