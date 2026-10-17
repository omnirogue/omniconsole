import { z } from 'zod'
import { taskPlan } from './task-details'
import { taskId, consoleWorkflowJson } from './console-workflow-schemas'
import { taskDependencySummary } from './task-dependencies-contract'
const text = z.string().nullish()
export const workCard = z.object({
  id: taskId,
  title: z.string(),
  status: z.string(),
  state_revision: z.number().int().nonnegative().nullish(),
  parent_task_id: text,
  source: text,
  kanban_eligible: z.boolean().nullish(),
  kanban_status: text,
  kanban_reason: text,
  kanban_disposition: text,
  kanban_badges: z
    .array(z.object({ kind: z.string(), label: z.string(), count: z.number().optional() }))
    .nullish(),
  work_schema_version: z.number().nullish(),
  verified_at: text,
  verification_failed_at: text,
  company_slug: text,
  org_company_id: text,
  org_unit_id: text,
  project_id: text,
  owner_employee_id: text,
  /** The board read trims this to 500 characters; the task sheet reads the whole card. */
  description: text,
  acceptance_criteria: text,
  /** Cross-cutting tags (hub migration 265): `proposed`, `company:<slug>`, …; see proposed-task.ts. */
  tags: z.array(z.string()).nullish(),
  actors: z
    .array(z.union([z.string(), z.object({ id: z.string(), role: z.string().nullish() })]))
    .nullish(),
  task_plan: taskPlan.nullish(),
  next_action: text,
  execution_state: text,
  execution_reason: text,
  triage_state: text,
  defer_until: text,
  paused_at: text,
  due_date: text,
  updated_at: text,
  dependency_summary: taskDependencySummary.nullish(),
  blocked: z
    .union([z.string(), z.boolean(), z.object({ text: z.string(), by: text, at: text })])
    .nullish()
})
export const workFolders = z.object({
  companies: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      domains: z.array(z.object({ id: z.string(), name: z.string() }))
    })
  )
})
export const workBoard = z.object({
  items: z.array(workCard),
  total: z.number(),
  capped: z.boolean(),
  companies: workFolders.shape.companies.optional(),
  filingUnavailable: z.boolean().optional()
})
export const workEvent = z.object({
  id: z.string(),
  task_id: taskId,
  actor: z.string(),
  event: z.string(),
  note: text,
  created_at: z.string(),
  from_status: text,
  to_status: text,
  note_kind: text,
  payload: consoleWorkflowJson.optional()
})
export const workNoteRequest = z
  .object({ taskId, note: z.string().trim().min(1).max(4000) })
  .strict()
export const workLifecycle = z
  .object({ task: z.object({ id: taskId }).passthrough() })
  .passthrough()
export const workSession = z.object({
  id: z.string(),
  board_task_id: text,
  task_title: text,
  task_summary: text,
  agent_name: text,
  agent_status: text,
  employee_id: text,
  machine_id: text,
  job_id: text,
  company: text,
  domain: text,
  last_seen: z.number().nullish()
})
export const workSessions = z.object({
  sessions: z.array(workSession),
  truncated: z.boolean().optional(),
  hub: z
    .object({
      pending: z.boolean().optional(),
      age_s: z.number().nullish(),
      cap: z.number().nullish()
    })
    .optional()
})
export type WorkCard = z.infer<typeof workCard>
export type WorkBoard = z.infer<typeof workBoard>
export type WorkEvent = z.infer<typeof workEvent>
export type WorkLifecycle = z.infer<typeof workLifecycle>
export type WorkSessions = z.infer<typeof workSessions>
