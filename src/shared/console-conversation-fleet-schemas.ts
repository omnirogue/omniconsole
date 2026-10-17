import { z } from 'zod'
import { taskId, workflowClassificationRequest, workflowGraph } from './console-workflow-schemas'
import { CONVERSATION_PERSON_HANDOFF_ACTOR } from './console-conversation-person-handoff'
import { matchesConversationFleetAdoption } from './console-conversation-fleet-adoption'
import {
  consoleConversationSourceFile,
  consoleConversationSourcePath,
  containsSourceControlCharacter
} from './console-conversation-source-files'
import type {
  ConsoleConversationFleetAdmitRequest,
  ConsoleConversationFleetPreviewRequest
} from './console-conversation-fleet-types'
import type { ConsoleWorkflowStep } from './console-workflow-types'

const text = z.string().min(1).max(32_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const machine = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/)
const sessionIdentity = text.max(512).refine((value) => !containsSourceControlCharacter(value))
const stage = workflowClassificationRequest.shape.steps.element.extend({
  title: text,
  detail: text.nullish(),
  brief: text.optional(),
  prompt: text.optional(),
  machine: machine.optional()
})
const classification = workflowClassificationRequest.extend({
  title: text,
  steps: z.array(stage).min(1).max(64)
})

function requiresAgentFanout(steps: ConsoleWorkflowStep[]): boolean {
  let pending = [...steps]
  const completed = new Set<string>()
  while (pending.length > 0) {
    const ready = pending.filter((step) => (step.after ?? []).every((key) => completed.has(key)))
    if (ready.length === 0 || ready.filter((step) => step.actor_type === 'ai').length > 1) {
      return true
    }
    for (const step of ready) {
      completed.add(step.key!)
    }
    pending = pending.filter((step) => !completed.has(step.key!))
  }
  return false
}

export const conversationFleetPreviewRequest: z.ZodType<ConsoleConversationFleetPreviewRequest> = z
  .object({
    taskId,
    expectedRevision: z.number().int().nonnegative(),
    classification,
    prompt: text.max(16_384),
    fanoutAck: z.boolean(),
    source: z
      .object({
        sessionRef: sessionIdentity,
        sessionId: sessionIdentity.optional(),
        transcriptDigest: digest.optional(),
        templateId: text.max(128).optional(),
        capturedAt: z.string().datetime({ offset: true }).optional()
      })
      .strict(),
    sourceFiles: z.array(consoleConversationSourceFile).max(32).optional(),
    sourceDeletions: z.array(consoleConversationSourcePath).max(256).optional(),
    sourceSummaryFile: consoleConversationSourceFile.optional()
  })
  .strict()
  .refine((value) =>
    value.classification.steps.every(
      (step) =>
        step.key &&
        step.actor_id &&
        step.action &&
        step.acceptance_commands !== undefined &&
        !step.loop &&
        (step.actor_type === 'ai'
          ? step.placement === 'fleet' && step.person_handoff === undefined
          : step.actor_type === 'mechanical' &&
            step.actor_id === CONVERSATION_PERSON_HANDOFF_ACTOR &&
            step.action === 'notify' &&
            step.person_handoff !== undefined &&
            (step.placement === undefined || step.placement === 'fleet') &&
            step.machine === undefined &&
            step.workspace === undefined &&
            step.repo === undefined &&
            step.base_branch === undefined &&
            step.base_sha === undefined &&
            step.effort === undefined &&
            step.acceptance_commands.length === 0)
    )
  )
  .refine((value) => value.classification.execution_mode !== undefined)
  .refine(
    (value) =>
      new Set(value.classification.steps.map((step) => step.key)).size ===
      value.classification.steps.length
  )
  .refine((value) => value.fanoutAck || !requiresAgentFanout(value.classification.steps))
  .refine((value) => (value.sourceFiles ?? []).every((file) => file.task_id === value.taskId))
  .refine(
    (value) =>
      !value.sourceSummaryFile ||
      (value.sourceSummaryFile.file.size_bytes <= 1024 * 1024 &&
        value.sourceSummaryFile.target_path === undefined &&
        (value.sourceFiles ?? []).some(
          (file) => JSON.stringify(file) === JSON.stringify(value.sourceSummaryFile)
        ))
  )
  .refine(
    (value) =>
      (value.sourceFiles ?? []).reduce((total, file) => total + file.file.size_bytes, 0) <=
      32 * 1024 * 1024
  )

export const conversationFleetAdmitRequest: z.ZodType<ConsoleConversationFleetAdmitRequest> = z
  .object({
    taskId,
    expectedRevision: z.number().int().nonnegative(),
    graph: workflowGraph,
    digest,
    contextDigest: digest,
    adoptStage: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,95}$/)
      .nullable()
  })
  .strict()
  .refine((value) => value.digest === value.graph.digest)
  .refine((value) => matchesConversationFleetAdoption(value.graph, value.adoptStage))
  .refine((value) =>
    value.graph.nodes.every((node) => node.actor_type !== 'ai' || node.placement === 'fleet')
  )
