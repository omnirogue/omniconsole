import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { taskId } from '../../shared/console-workflow-schemas'
import type { ConsoleLocalJob } from '../console-workflows/console-local-execution-contract'
import { readConsoleWorkflowHandoff } from './console-workflow-handoff'
import { requestConsoleWorkflow } from './console-workflow-transport'

const card = z.object({
  id: taskId,
  parent_task_id: taskId.nullish(),
  project_id: z.string().min(1),
  company_slug: z.string().min(1),
  owner_employee_id: z.string().min(1)
})
const personReply = z.object({
  ok: z.literal(true),
  mode: z.literal('clerk'),
  user: z.object({ employee_id: z.string().min(1) })
})
type Person = { principal: string; isCurrent(): boolean }

/** Parentage supplements the exact signed child input contract; it never substitutes for it. */
export async function authorizeParentTaskInputs(
  job: ConsoleLocalJob,
  sourceTaskIds: string[],
  person: Person
): Promise<() => Promise<void>> {
  const roots = [...new Set(sourceTaskIds.filter((id) => id !== job.taskId))]
  if (!roots.length) {
    return async () => {}
  }
  if (roots.length !== 1 || !taskId.safeParse(roots[0]).success) {
    throw new Error('The admitted input names a different task.')
  }
  const verify = async () => {
    if (!person.isCurrent()) {
      throw new Error('The signed-in person changed while reading task inputs.')
    }
    const current = await readConsoleWorkflowHandoff(job.id, person.principal)
    if (
      !current.ok ||
      current.data.state !== 'running' ||
      !isDeepStrictEqual(current.data, { ...job, state: current.data.state })
    ) {
      throw new Error(
        'The admitted input names a different task or its signed child contract changed.'
      )
    }
    const readCard = (id: string) =>
      requestConsoleWorkflow(
        `/api/gtd/hub/api/board/${id}`,
        'GET',
        card,
        undefined,
        15_000,
        true,
        person.principal,
        person.isCurrent
      )
    const [child, parent, me] = await Promise.all([
      readCard(job.taskId),
      readCard(roots[0]),
      requestConsoleWorkflow(
        '/api/me',
        'GET',
        personReply,
        undefined,
        15_000,
        true,
        person.principal,
        person.isCurrent
      )
    ])
    if (
      !child.ok ||
      !parent.ok ||
      !me.ok ||
      !person.isCurrent() ||
      child.data.id !== job.taskId ||
      parent.data.id !== roots[0] ||
      child.data.parent_task_id !== parent.data.id ||
      child.data.project_id !== parent.data.project_id ||
      child.data.company_slug !== parent.data.company_slug ||
      child.data.owner_employee_id !== me.data.user.employee_id ||
      parent.data.owner_employee_id !== me.data.user.employee_id
    ) {
      throw new Error(
        'The admitted input names a different task or its current parent authority changed.'
      )
    }
  }
  await verify()
  return verify
}

export async function readOwnedInputTask(id: string, person: Person) {
  taskId.parse(id)
  const [task, me] = await Promise.all([
    requestConsoleWorkflow(
      `/api/gtd/hub/api/board/${id}`,
      'GET',
      card,
      undefined,
      15_000,
      true,
      person.principal,
      person.isCurrent
    ),
    requestConsoleWorkflow(
      '/api/me',
      'GET',
      personReply,
      undefined,
      15_000,
      true,
      person.principal,
      person.isCurrent
    )
  ])
  if (
    !task.ok ||
    !me.ok ||
    !person.isCurrent() ||
    task.data.id !== id ||
    task.data.owner_employee_id !== me.data.user.employee_id
  ) {
    throw new Error('The current task owner must authorize the selected input files.')
  }
  return task.data
}
