import type {
  ConsoleTaskRecord,
  ConsoleWorkflowJson,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import type { TaskDetailsPatch } from '../../shared/task-details'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { taskDetail, taskMutation } from './console-workflow-records'
import { failure, requestConsoleWorkflow as request } from './console-workflow-transport'

export async function readConsoleTaskDetails(
  taskId: string
): Promise<ConsoleWorkflowResult<ConsoleTaskRecord>> {
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  const { principal, isCurrent } = person.data
  const saved = await request(
    `/api/gtd/hub/api/board/${taskId}`,
    'GET',
    taskDetail.refine((task) => task.id === taskId),
    undefined,
    15_000,
    true,
    principal,
    isCurrent
  )
  if (!saved.ok) {
    return saved
  }
  if (!isCurrent()) {
    return failure(
      'connection_changed',
      'The signed-in person changed; reopen the task before continuing.'
    )
  }
  return { ok: true, data: { ...saved.data, publicationPrincipal: principal } }
}

export async function updateConsoleTaskDetails(
  input: TaskDetailsPatch & {
    taskId: string
    expectedRevision: number
  }
): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>> {
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return person
  }
  const { principal, isCurrent } = person.data
  const fields = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.acceptanceCriteria !== undefined
      ? { acceptance_criteria: input.acceptanceCriteria }
      : {}),
    ...(input.taskPlan !== undefined ? { task_plan: input.taskPlan } : {}),
    ...(input.dueDate !== undefined ? { due_date: input.dueDate ?? '' } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.sequentialSteps !== undefined ? { sequential_steps: input.sequentialSteps } : {})
  }
  const written = await request(
    `/api/collab/board/${input.taskId}`,
    'PATCH',
    taskMutation,
    { expected_revision: input.expectedRevision, ...fields },
    15_000,
    true,
    principal,
    isCurrent
  )
  if (!written.ok) {
    return written
  }
  const saved = await request(
    `/api/gtd/hub/api/board/${input.taskId}`,
    'GET',
    taskDetail,
    undefined,
    15_000,
    true,
    principal,
    isCurrent
  )
  if (!saved.ok) {
    return saved
  }
  const matches = Object.entries(fields).every(([field, value]) => {
    const actual = saved.data[field as keyof typeof saved.data]
    return (
      actual === value ||
      (value === '' && actual === null) ||
      (value !== null &&
        typeof value === 'object' &&
        JSON.stringify(actual) === JSON.stringify(value))
    )
  })
  if (
    !isCurrent() ||
    saved.data.id !== input.taskId ||
    !matches ||
    saved.data.state_revision == null ||
    saved.data.state_revision < input.expectedRevision
  ) {
    return failure(
      'task_save_unconfirmed',
      'The saved task did not match your changes. Reload it before retrying.'
    )
  }
  return {
    ok: true,
    data: { ok: true, taskId: input.taskId, principal, stateRevision: saved.data.state_revision }
  }
}
