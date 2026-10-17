import { z } from 'zod'
import { taskDependencySummary } from '../../shared/task-dependencies-contract'
import { taskPlan } from '../../shared/task-details'
import {
  consoleJobArtifactReceipt,
  consolePersonHandoffStatus,
  consolePersonHandoffDelivery
} from '../../shared/console-job-results'
import {
  consoleWorkflowJson,
  jobId,
  taskId,
  workflowActor
} from '../../shared/console-workflow-schemas'
import type {
  ConsoleJobEvent,
  ConsoleJobRecord,
  ConsoleTaskRecord
} from '../../shared/console-workflow-types'
import { workflowPolicy } from './console-workflow-responses'

const nullableText = z.string().nullish()
const blockedReason = z
  .union([
    z.string(),
    z
      .object({ detail: nullableText, reason: nullableText })
      .transform((value) => value.detail || value.reason || null)
  ])
  .nullish()
const jsonObject = z.record(z.string(), consoleWorkflowJson)

export const jobEvent: z.ZodType<ConsoleJobEvent> = z
  .object({
    id: z.number().int().positive(),
    job_id: jobId,
    kind: z.string(),
    detail: jsonObject,
    created_at: z.string().optional(),
    at: z.string().optional(),
    machine: nullableText
  })
  .refine((event) => !!(event.created_at ?? event.at), 'An event needs its recorded timestamp.')
  .transform(({ at, ...event }) => ({ ...event, created_at: event.created_at ?? at! }))
export const jobRecord: z.ZodType<ConsoleJobRecord> = z.object({
  id: jobId,
  // Why: the live console lists jobs whose task ids come from the hub's own grammar, not
  // only board cards; one such row must not hide the whole list. Card-bound actions still
  // require a `btk_` id at the route allowlist, so a foreign id is listed, never acted on.
  task_id: z.string().min(1),
  title: z.string(),
  status: z.string(),
  brief: z.string().optional(),
  acceptance: z.string().optional(),
  repo: nullableText,
  base_branch: z.string().nullish(),
  branch: nullableText,
  machine: nullableText,
  provider: nullableText,
  model: nullableText,
  effort: nullableText,
  actor_type: workflowActor.optional(),
  attempt: z.number().int().nonnegative().optional(),
  lease_generation: z.number().int().nonnegative().optional(),
  owned_paths: z.array(z.string()).nullish(),
  pr_url: nullableText,
  output_tail: nullableText,
  last_error: nullableText,
  updated_at: nullableText,
  execution_artifacts: z.array(consoleJobArtifactReceipt).max(1).optional(),
  policy: z.object({
    workflow: workflowPolicy.optional(),
    human_result: jsonObject.optional(),
    person_handoff_delivery: consolePersonHandoffDelivery.optional(),
    person_handoff_status: consolePersonHandoffStatus.optional()
  }),
  events: z.array(jobEvent).optional()
})
export const jobList = z.object({
  jobs: z.array(jobRecord),
  conversation_source_scope: z.literal('directing_person').optional()
})
export const jobEvents = z.object({ job_id: jobId, events: z.array(jobEvent) })
export const localJobEvents = jobEvents.extend({
  ok: z.literal(true),
  next_after: z.number().int().nonnegative(),
  cancel_requested: z.boolean(),
  status: z.string()
})
const taskRecord: z.ZodType<ConsoleTaskRecord> = z.object({
  kanban_status: nullableText,
  kanban_reason: nullableText,
  kanban_disposition: nullableText,
  kanban_eligible: z.boolean().nullish(),
  parent_task_id: nullableText,
  verified_at: nullableText,
  verification_failed_at: nullableText,
  id: taskId,
  title: z.string().min(1),
  status: z.string().min(1),
  state_revision: z.number().int().nonnegative().nullish(),
  sequential_steps: z.array(z.string()).optional(),
  task_plan: taskPlan.nullish(),
  next_action: nullableText,
  owner_employee_id: nullableText,
  acceptance_criteria: nullableText,
  current_contract_id: nullableText,
  description: nullableText,
  due_date: nullableText,
  company_slug: nullableText,
  priority: nullableText,
  requester_employee_id: nullableText,
  blocked_reason: blockedReason,
  result_ref: nullableText,
  tags: z.array(z.string()).nullish(),
  created_at: nullableText,
  updated_at: nullableText,
  dependency_summary: taskDependencySummary.nullish()
})
export const taskDetail = z.union([
  taskRecord,
  z.object({ task: taskRecord }).transform((value) => value.task)
])
export const taskMutation = jsonObject.refine((value) => value.ok === true)
/** The lifecycle verb answers with the moved card, whose shape the board re-reads anyway. */
export const taskLifecycleResult = jsonObject
