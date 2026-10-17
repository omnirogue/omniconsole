import { z } from 'zod'

export const TASK_DESCRIPTION_MAX = 8000
export const taskPriority = z.enum(['urgent', 'high', 'normal', 'low'])
export type TaskPriority = z.infer<typeof taskPriority>
export const taskSequentialSteps = z.array(z.string().trim().min(1).max(2000)).max(100)
export const taskPlanStep = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    title: z.string().trim().min(1).max(2000),
    actor_ids: z.array(z.string().trim().min(1).max(200)).max(100)
  })
  .strict()
export const taskPlan = z
  .object({
    version: z.literal(1),
    steps: z.array(taskPlanStep).max(100),
    completion_mode: z.enum(['deliverable', 'deployment']),
    deployment_target: z.string().trim().min(1).max(2000).optional()
  })
  .strict()
  .refine((value) => new Set(value.steps.map((step) => step.id)).size === value.steps.length, {
    message: 'Each task step needs a unique identity.'
  })
  .refine((value) => value.completion_mode === 'deployment' || !value.deployment_target, {
    message: 'A deployment target requires deployment as the completion outcome.'
  })
export type TaskPlan = z.infer<typeof taskPlan>
export type TaskPlanStep = z.infer<typeof taskPlanStep>
export function taskPlanFromSteps(steps: readonly string[]): TaskPlan {
  return {
    version: 1,
    completion_mode: 'deliverable',
    steps: steps.map((title, index) => ({ id: `step_${index + 1}`, title, actor_ids: [] }))
  }
}
export const taskDueDate = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/)
export const taskDetailsFields = {
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(TASK_DESCRIPTION_MAX).optional(),
  acceptanceCriteria: z.string().max(TASK_DESCRIPTION_MAX).optional(),
  taskPlan: taskPlan.nullable().optional(),
  dueDate: taskDueDate.nullable().optional(),
  priority: taskPriority.optional(),
  sequentialSteps: taskSequentialSteps.optional()
}
export const hasTaskUpdateFields = (value: Record<string, unknown>): boolean =>
  Object.entries(value).some(
    ([key, field]) => field !== undefined && !['taskId', 'expectedRevision'].includes(key)
  )
export type TaskDetailsDraft = {
  title: string
  description: string
  acceptanceCriteria?: string
  taskPlan?: TaskPlan
  dueDate: string
  priority: TaskPriority
  sequentialSteps: string[]
}
export type TaskDetailsPatch = {
  title?: string
  description?: string
  acceptanceCriteria?: string
  taskPlan?: TaskPlan | null
  dueDate?: string | null
  priority?: TaskPriority
  sequentialSteps?: string[]
}
