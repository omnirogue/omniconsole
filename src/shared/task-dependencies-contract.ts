import { z } from 'zod'
import { taskId } from './console-workflow-schemas'

/**
 * Lane G (2026-09-15): a task's dependency edges as the hub derives them and the console
 * relays them. Fields past the ids are nullish on the wire; an edge the console marks
 * `restricted` is reduced to a count by `redactRestrictedDependencies` before any renderer.
 */
export const TASK_DEPENDENCY_STATES = ['waiting', 'satisfied', 'unmeetable', 'missing'] as const
export const TASK_DEPENDENCY_CONDITIONS = ['DONE', 'VERIFIED'] as const

const count = z.number().int().nonnegative().nullish()
export const taskDependencySummary = z.object({
  waiting: count,
  satisfied: count,
  unmeetable: count,
  missing: count
})

export const taskDependencyEdge = z.object({
  /** Always the OTHER task. */
  task_id: taskId,
  title: z.string().nullish(),
  status: z.string().nullish(),
  condition: z.enum(TASK_DEPENDENCY_CONDITIONS).nullish(),
  state: z.enum(TASK_DEPENDENCY_STATES).nullish(),
  reason: z.string().nullish(),
  created_by: z.string().nullish(),
  restricted: z.boolean().optional()
})

const taskDependencyGraphWire = z.object({
  task_id: taskId,
  depends_on: z.array(taskDependencyEdge).nullish(),
  dependents: z.array(taskDependencyEdge).nullish(),
  truncated: z.boolean().optional()
})

/** Edges withheld from this reader: only how many, never which task or its state. */
export type TaskDependencyHidden = {
  depends_on: number
  dependents: number
  /** Hidden prerequisites the console reported as unmeetable or missing. */
  blocking: number
}

export type TaskDependencyGraph = {
  task_id: string
  /** `null` means the direction could not be read, not that it is empty. */
  depends_on: TaskDependencyEdge[] | null
  dependents: TaskDependencyEdge[] | null
  truncated?: boolean
  hidden?: TaskDependencyHidden
}

type TaskDependencyGraphInput = z.infer<typeof taskDependencyGraphWire> & {
  hidden?: TaskDependencyHidden
}

/**
 * Why at the boundary: a `restricted` edge names a task the reader may not open, so its id,
 * condition and state must never reach a renderer. Only counts survive; idempotent.
 */
export function redactRestrictedDependencies(graph: TaskDependencyGraphInput): TaskDependencyGraph {
  const split = (edges: TaskDependencyEdge[] | null | undefined) => {
    if (!edges) {
      return { visible: null, hidden: 0, blocking: 0 }
    }
    const withheld = edges.filter((edge) => edge.restricted)
    return {
      visible: edges
        .filter((edge) => !edge.restricted)
        .map(({ restricted: _restricted, ...edge }) => edge),
      hidden: withheld.length,
      blocking: withheld.filter((edge) => edge.state === 'unmeetable' || edge.state === 'missing')
        .length
    }
  }
  const up = split(graph.depends_on)
  const down = split(graph.dependents)
  const prior = graph.hidden ?? { depends_on: 0, dependents: 0, blocking: 0 }
  return {
    task_id: graph.task_id,
    depends_on: up.visible,
    dependents: down.visible,
    ...(graph.truncated === undefined ? {} : { truncated: graph.truncated }),
    hidden: {
      depends_on: prior.depends_on + up.hidden,
      dependents: prior.dependents + down.hidden,
      blocking: prior.blocking + up.blocking
    }
  }
}

export const taskDependencyGraph = taskDependencyGraphWire.transform(redactRestrictedDependencies)

export const taskDependencyAddRequest = z
  .object({
    taskId,
    dependsOnTaskId: taskId,
    condition: z.enum(TASK_DEPENDENCY_CONDITIONS).optional()
  })
  .strict()
  .refine((value) => value.taskId !== value.dependsOnTaskId)

export const taskDependencyRemoveRequest = z.object({ taskId, dependsOnTaskId: taskId }).strict()

/** The hub's POST answer keeps its original keys and nests the edge as its dependent reads it. */
export function taskDependencyAddAnswer(dependsOnTaskId: string) {
  return z
    .object({
      depends_on_task_id: z.literal(dependsOnTaskId),
      condition: z.enum(TASK_DEPENDENCY_CONDITIONS).nullish(),
      state: z.enum(TASK_DEPENDENCY_STATES).nullish(),
      reason: z.string().nullish(),
      created_by: z.string().nullish(),
      edge: taskDependencyEdge.nullish()
    })
    .transform(
      (answer): TaskDependencyEdge =>
        answer.edge ?? {
          task_id: answer.depends_on_task_id,
          title: null,
          status: null,
          condition: answer.condition ?? null,
          state: answer.state ?? null,
          reason: answer.reason ?? null,
          created_by: answer.created_by ?? null
        }
    )
    .refine((edge) => edge.task_id === dependsOnTaskId)
}

export const taskDependencyRemoveAnswer = z.object({ removed: z.boolean() })

export type TaskDependencySummary = z.infer<typeof taskDependencySummary>
export type TaskDependencyEdge = z.infer<typeof taskDependencyEdge>
export type TaskDependencyState = (typeof TASK_DEPENDENCY_STATES)[number]
export type TaskDependencyCondition = (typeof TASK_DEPENDENCY_CONDITIONS)[number]
export type TaskDependencyAddRequest = z.infer<typeof taskDependencyAddRequest>
export type TaskDependencyRemoveRequest = z.infer<typeof taskDependencyRemoveRequest>
