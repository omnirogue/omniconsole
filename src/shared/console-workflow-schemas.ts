import { openrouterCandidates } from './openrouter-route'
import { workflowMode, workflowActor, workflowAction } from './console-workflow-stage-enums'
export { workflowMode, workflowActor, workflowAction } from './console-workflow-stage-enums'
import { sessionOutcomeCurrentSource } from './session-outcome-current-inputs'
import { workflowFolderWorkspace, workflowNodeWorkspace } from './console-workflow-workspace'
export { workflowFolderWorkspace, workflowNodeWorkspace } from './console-workflow-workspace'
import { z } from 'zod'
import { hasTaskUpdateFields, taskDetailsFields } from './task-details'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import { consoleWorkflowAcceptanceCommands } from './console-workflow-acceptance'
import { consoleWorkflowLoop } from './console-workflow-loop'
import {
  conversationHandoffReport,
  conversationHandoffOutput
} from './console-conversation-handoff-report'
import {
  conversationPersonHandoff,
  conversationPersonHandoffRequest
} from './console-conversation-person-handoff'
import {
  consoleConversationSourceFile,
  consoleConversationSourcePath
} from './console-conversation-source-files'
import type {
  ConsoleWorkflowAdmitRequest,
  ConsoleWorkflowClassifyRequest,
  ConsoleWorkflowGraph,
  ConsoleWorkflowJson,
  ConsoleWorkflowPreviewRequest
} from './console-workflow-types'

export const consoleWorkflowJson: z.ZodType<ConsoleWorkflowJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(consoleWorkflowJson),
    z.record(z.string(), consoleWorkflowJson)
  ])
)
const jsonObject = z.record(z.string(), consoleWorkflowJson)
const text = z.string().trim().min(1).max(32_000)
const optionalText = text.nullish()
const stageKey = z.string().regex(/^[a-z][a-z0-9_-]{0,95}$/)
export const workflowId = z.string().regex(/^wf_[A-Za-z0-9_-]{1,128}$/)
export const jobId = z.string().regex(/^job_[a-z0-9]{8,40}$/)
export const taskId = z.string().regex(BOARD_TASK_ID_PATTERN)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const workflowMechanicalExecution = z
  .object({ handler_key: z.string().min(1).max(32_000), handler_digest: digest, input: jsonObject })
  .strict()

const step = z
  .object({
    handoff_report: conversationHandoffReport.optional(),
    output_artifacts: z.array(conversationHandoffOutput).max(32).optional(),
    person_handoff: conversationPersonHandoffRequest.optional(),
    workspace: workflowFolderWorkspace.optional(),
    key: stageKey.optional(),
    title: text,
    detail: optionalText,
    brief: text.optional(),
    prompt: text.optional(),
    actor: optionalText,
    actor_id: text.optional(),
    openrouter_candidates: openrouterCandidates.optional(),
    actor_type: workflowActor.optional(),
    action: workflowAction.optional(),
    department: text.optional(),
    repo: text.optional(),
    base_branch: text.optional(),
    base_sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    placement: z.enum(['local', 'fleet']).optional(),
    machine: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
      .optional(),
    effort: optionalText,
    acceptance: text.optional(),
    acceptance_commands: consoleWorkflowAcceptanceCommands.optional(),
    timing: z.enum(['now', 'scheduled', 'later']).optional(),
    after: z.array(stageKey).max(64).optional(),
    parallel_group: optionalText,
    files: z.array(text.max(512)).max(200).optional(),
    timeout_minutes: z.number().int().positive().max(1440).optional(),
    engineering: jsonObject.optional(),
    loop: consoleWorkflowLoop.nullish()
  })
  .strict()
export const workflowClassificationRequest = z
  .object({
    workspace: workflowFolderWorkspace.optional(),
    title: text,
    company_slug: text,
    domain_id: optionalText,
    repo: text.optional(),
    acceptance: text.optional(),
    execution_mode: workflowMode.optional(),
    policy: jsonObject.optional(),
    steps: z.array(step).min(1).max(64)
  })
  .strict()

export const previewRequest: z.ZodType<ConsoleWorkflowPreviewRequest> = z
  .object({
    classification: workflowClassificationRequest,
    prompt: text.optional(),
    draft: text.optional(),
    title: text.optional()
  })
  .strict()

// Frozen graph strings are preserved byte-for-byte; trimming would invalidate its digest.
const frozenText = z.string().min(1).max(64_000)
export const workflowGraph: z.ZodType<ConsoleWorkflowGraph> = z
  .object({
    schema_version: z.literal(1),
    mode: workflowMode,
    title: frozenText,
    prompt: frozenText,
    company: frozenText,
    owner: z.string().regex(/^emp_[A-Za-z0-9_-]{1,80}$/),
    policy: jsonObject,
    nodes: z
      .array(
        z
          .object({
            handoff_report: conversationHandoffReport.optional(),
            output_artifacts: z.array(conversationHandoffOutput).max(32).optional(),
            person_handoff: conversationPersonHandoff.optional(),
            mechanical_execution: workflowMechanicalExecution.optional(),
            workspace: workflowNodeWorkspace.optional(),
            key: stageKey,
            title: frozenText,
            brief: frozenText,
            actor_type: workflowActor,
            actor_id: frozenText,
            action: workflowAction,
            after: z.array(stageKey).max(64),
            owned_paths: z.array(frozenText).max(200).nullable(),
            provider: frozenText.optional(),
            model: frozenText.optional(),
            openrouter_candidates: openrouterCandidates.optional(),
            effort: frozenText.nullish(),
            repo: frozenText.nullish(),
            base_branch: frozenText.nullish(),
            base_sha: z
              .string()
              .regex(/^[a-f0-9]{40}$/)
              .optional(),
            placement: z.enum(['local', 'fleet']).optional(),
            machine: z
              .string()
              .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
              .optional(),
            source_files: z.array(consoleConversationSourceFile).max(32).optional(),
            source_deletions: z.array(consoleConversationSourcePath).max(256).optional(),
            source_overlay: z.boolean().optional(),
            acceptance: z.string().optional(),
            acceptance_commands: consoleWorkflowAcceptanceCommands.optional(),
            department: frozenText.optional(),
            agent: frozenText.optional(),
            timing: frozenText.optional(),
            timeout_minutes: z.number().optional(),
            loop: jsonObject.optional(),
            loop_stage: jsonObject.optional(),
            external_predecessor: jsonObject.optional(),
            current_source: sessionOutcomeCurrentSource.optional(),
            parallel_group: frozenText.optional()
          })
          .passthrough()
      )
      .min(1)
      .max(64),
    columns: z.array(z.array(stageKey).max(64)).max(64),
    dispatch_id: workflowId,
    digest
  })
  .passthrough()

export const workflowObjective = z
  .object({
    goal_id: text.max(256),
    title: text,
    desired_result: text,
    acceptance_policy: jsonObject.refine((value) => Object.keys(value).length > 0),
    verification_policy: jsonObject.refine((value) => Object.keys(value).length > 0)
  })
  .strict()

export const admitRequest: z.ZodType<ConsoleWorkflowAdmitRequest> = z
  .object({
    graph: workflowGraph,
    digest,
    filing_root_task_id: taskId.optional(),
    filing_root_expected_revision: z.number().int().nonnegative().optional(),
    card_id: taskId.optional(),
    expected_revision: z.number().int().nonnegative().optional(),
    adopt_stage: stageKey.optional(),
    objective: workflowObjective,
    org_unit_id: text.max(256),
    expected_authority_epoch: z.number().int().nonnegative()
  })
  .strict()
  .refine((value) => value.digest === value.graph.digest)
  .refine((value) =>
    value.filing_root_task_id === undefined
      ? value.filing_root_expected_revision === undefined
      : value.filing_root_expected_revision !== undefined && value.card_id === undefined
  )
  .refine((value) =>
    value.card_id === undefined
      ? value.expected_revision === undefined && value.adopt_stage === undefined
      : value.expected_revision !== undefined
  )

export const classifyRequest: z.ZodType<ConsoleWorkflowClassifyRequest> = z
  .object({
    draft: text.max(8000),
    companies: z
      .array(
        z
          .object({
            slug: text.max(128),
            name: text.max(256),
            mission: text.max(512).nullish(),
            domains: z.array(z.object({ id: text.max(128), name: text.max(256) }).strict()).max(60)
          })
          .strict()
      )
      .max(40),
    people: z.array(z.object({ id: text.max(128), name: text.max(256) }).strict()).max(40),
    primary_company_slug: text.max(128).nullish()
  })
  .strict()
export const workflowRequest = z.object({ workflowId }).strict()
export const jobRequest = z.object({ jobId }).strict()
export const taskRequest = z.object({ taskId }).strict()
export const jobsRequest = z
  .object({ taskId: taskId.optional(), conversationSource: z.boolean().optional() })
  .strict()
  .refine((value) => !value.conversationSource || value.taskId === undefined)
export const jobEventsRequest = z
  .object({
    jobId,
    limit: z.number().int().min(1).max(500).optional(),
    eventId: z.number().int().positive().optional(),
    after: z.number().int().nonnegative().optional(),
    placement: z.enum(['local', 'fleet']).optional()
  })
  .strict()
  .refine((value) => value.after === undefined || value.eventId === undefined)
export const taskUpdateRequest = z
  .object({
    taskId,
    expectedRevision: z.number().int().nonnegative(),
    ...taskDetailsFields,
    nextAction: text.optional(),
    blockedReason: z.string().trim().min(1).max(8000).optional(),
    /** The card's whole tag list (the hub replaces, never merges); bounds are the hub's own. */
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional()
  })
  .strict()
  .refine(hasTaskUpdateFields)
export const taskCompletionRequest = z
  .object({
    taskId,
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()
export const sessionIngestRequest = z
  .object({
    sessionRef: z.string().trim().min(1).max(200),
    cwd: text.max(1000),
    provider: z.string().trim().min(1).max(40),
    title: text.max(500).optional(),
    model: text.max(120).optional(),
    description: text.max(2000).optional()
  })
  .strict()
export const sessionAttachRequest = z
  .object({
    sessionId: z.string().regex(/^ses_[A-Za-z0-9]{4,64}$/),
    taskId: z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/)
  })
  .strict()
export const taskCardRequest = z
  .object({ taskId: z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/) })
  .strict()
export const bulkDismissRequest = z
  .object({ dryRun: z.boolean(), note: text.max(3000).optional() })
  .strict()
export const decisionRequest = z
  .object({
    jobId,
    decision: z.enum(['approve', 'reject', 'complete']),
    note: text.max(3000)
  })
  .strict()
