import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleLocalJob } from '../console-workflows/console-local-execution-contract'
import { authorizeParentTaskInputs } from './console-parent-task-inputs'
import { readConsoleWorkflowHandoff } from './console-workflow-handoff'
import { requestConsoleWorkflow } from './console-workflow-transport'
vi.mock('./console-workflow-handoff', () => ({ readConsoleWorkflowHandoff: vi.fn() }))
vi.mock('./console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
const root = 'btk_parent1234'
const job = {
  id: 'job_parent1234',
  taskId: 'btk_child1234',
  digest: 'a'.repeat(64),
  state: 'running',
  inputs: [
    {
      kind: 'task_file',
      task_id: root,
      file: { rel: 'files/input.txt', sha256: 'b'.repeat(64), size_bytes: 8 }
    }
  ]
} as ConsoleLocalJob
const person = { principal: 'c'.repeat(64), isCurrent: vi.fn(() => true) }
let child: Record<string, unknown>
let parent: Record<string, unknown>
beforeEach(() => {
  vi.resetAllMocks()
  person.isCurrent.mockReturnValue(true)
  child = {
    id: job.taskId,
    parent_task_id: root,
    project_id: 'project_1',
    company_slug: 'example',
    owner_employee_id: 'emp_owner'
  }
  parent = { ...child, id: root, parent_task_id: null }
  vi.mocked(readConsoleWorkflowHandoff).mockResolvedValue({ ok: true, data: structuredClone(job) })
  vi.mocked(requestConsoleWorkflow).mockImplementation(
    async (path) =>
      ({
        ok: true,
        data:
          path === '/api/me'
            ? { ok: true, mode: 'clerk', user: { employee_id: 'emp_owner' } }
            : path.endsWith(root)
              ? parent
              : child
      }) as never
  )
})
describe('exact signed parent task inputs', () => {
  it('preserves ordinary same-task behavior without extra authority reads', async () => {
    await (
      await authorizeParentTaskInputs(job, [job.taskId], person)
    )()
    expect(readConsoleWorkflowHandoff).not.toHaveBeenCalled()
  })
  it('requires the exact signed child pins and rechecks the current relationship', async () => {
    const after = await authorizeParentTaskInputs(job, [root], person)
    await after()
    expect(readConsoleWorkflowHandoff).toHaveBeenCalledTimes(2)
    expect(requestConsoleWorkflow).toHaveBeenCalledWith(
      '/api/me',
      'GET',
      expect.anything(),
      undefined,
      15000,
      true,
      person.principal,
      person.isCurrent
    )
  })
  it.each(['parent_task_id', 'project_id', 'company_slug', 'owner_employee_id'])(
    'refuses a changed child %s',
    async (field) => {
      child[field] = 'other'
      await expect(authorizeParentTaskInputs(job, [root], person)).rejects.toThrow('different task')
    }
  )
  it('refuses parent ownership changed during a download', async () => {
    const after = await authorizeParentTaskInputs(job, [root], person)
    parent.owner_employee_id = 'emp_other'
    await expect(after()).rejects.toThrow('authority changed')
  })
  it('does not use a true parent relationship to approve changed file pins', async () => {
    const changed = structuredClone(job)
    changed.inputs = []
    vi.mocked(readConsoleWorkflowHandoff).mockResolvedValue({ ok: true, data: changed })
    await expect(authorizeParentTaskInputs(job, [root], person)).rejects.toThrow(
      'signed child contract'
    )
    expect(requestConsoleWorkflow).not.toHaveBeenCalled()
  })
  it('refuses a revoked identity before a further read', async () => {
    person.isCurrent.mockReturnValue(false)
    await expect(authorizeParentTaskInputs(job, [root], person)).rejects.toThrow('person changed')
    expect(readConsoleWorkflowHandoff).not.toHaveBeenCalled()
  })
})
