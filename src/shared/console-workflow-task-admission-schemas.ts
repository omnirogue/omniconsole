import { z } from 'zod'
import {
  taskId,
  workflowClassificationRequest,
  workflowGraph,
  workflowObjective
} from './console-workflow-schemas'
import type {
  ConsoleTaskAdmitRequest,
  ConsoleTaskPreviewRequest
} from './console-workflow-task-types'
import type { ConsoleWorkflowGraph } from './console-workflow-types'

const stageKey = z.string().regex(/^[a-z][a-z0-9_-]{0,95}$/)

export function isSequentialConsoleWorkflow(graph: ConsoleWorkflowGraph): boolean {
  const keys = graph.columns.flat()
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  return (
    ['sequential', 'single_shot'].includes(graph.mode) &&
    graph.columns.every((column) => column.length === 1) &&
    keys.length === graph.nodes.length &&
    new Set(keys).size === keys.length &&
    keys.every((key, index) => {
      const node = nodes.get(key)
      return (
        node &&
        (index
          ? node.after.length === 1 && node.after[0] === keys[index - 1]
          : node.after.length === 0)
      )
    })
  )
}

export const taskPreviewRequest: z.ZodType<ConsoleTaskPreviewRequest> = z
  .object({
    taskId,
    expectedRevision: z.number().int().nonnegative(),
    placement: z.enum(['local', 'fleet']),
    prompt: z.string().min(1).max(32_000),
    templateId: z.string().min(1).optional(),
    presetId: z.string().min(1).optional(),
    classification: workflowClassificationRequest
  })
  .strict()
  .refine((value) => value.classification.execution_mode === 'sequential')
  .refine((value) =>
    value.classification.steps.every((step) => step.key && step.actor_type && step.actor_id)
  )
  .refine(
    (value) =>
      new Set(value.classification.steps.map((step) => step.key)).size ===
      value.classification.steps.length
  )

export const taskAdmissionContext = z
  .object({
    objective: workflowObjective,
    orgUnitId: z.string().trim().min(1).max(256),
    expectedAuthorityEpoch: z.number().int().nonnegative(),
    adoptStage: stageKey
  })
  .strict()

export const taskAdmitRequest: z.ZodType<ConsoleTaskAdmitRequest> = taskAdmissionContext
  .extend({
    taskId,
    expectedRevision: z.number().int().nonnegative(),
    placement: z.enum(['local', 'fleet']),
    graph: workflowGraph,
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .refine((value) => value.digest === value.graph.digest)
  .refine((value) => isSequentialConsoleWorkflow(value.graph))
  .refine((value) => value.graph.nodes.some((node) => node.key === value.adoptStage))
  .refine((value) =>
    value.graph.nodes.every(
      (node) => node.actor_type !== 'ai' || node.acceptance_commands !== undefined
    )
  )
