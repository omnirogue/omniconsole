// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskDetailsEditor } from './TaskDetailsEditor'

const fixture = vi.hoisted(() => ({ getTask: vi.fn(), updateTask: vi.fn(), scope: 'person-a' }))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => fixture
}))
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({
    people: { phase: 'ready', value: [{ id: 'emp_gamma', name: 'Gamma' }] }
  })
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ scope: fixture.scope }),
    { getState: () => ({ scope: fixture.scope }) }
  )
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: (state: { scope: string }) => state.scope
}))
vi.mock('@/components/handoffs/HandoffFilePicker', () => ({ HandoffFilePicker: () => null }))
const task = {
  id: 'btk_outcome1',
  title: 'Launch',
  status: 'open',
  state_revision: 7,
  description: 'Initial brief',
  due_date: '2026-09-30T15:00:00Z',
  priority: 'normal',
  sequential_steps: ['AI drafts', 'Sal reviews'],
  publicationPrincipal: 'a'.repeat(64)
}
afterEach(cleanup)
beforeEach(() => {
  fixture.scope = 'person-a'
  fixture.getTask.mockReset().mockResolvedValue({ ok: true, data: task })
  fixture.updateTask.mockReset().mockResolvedValue({
    ok: true,
    data: { taskId: task.id, stateRevision: 8, principal: task.publicationPrincipal }
  })
})

it('preserves step assignments and deployment requirements while editing the outcome', async () => {
  const plan = {
    version: 1,
    completion_mode: 'deployment',
    deployment_target: 'Staging',
    steps: [
      { id: 'draft', title: 'AI drafts', actor_ids: [] },
      { id: 'review', title: 'Gamma reviews', actor_ids: ['emp_gamma'] }
    ]
  }
  fixture.getTask.mockResolvedValue({ ok: true, data: { ...task, task_plan: plan } })
  render(<TaskDetailsEditor taskId={task.id} onSaved={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
  await screen.findByLabelText('End outcome')
  expect(screen.getByRole('button', { name: 'People for step 2' }).textContent).toContain('Gamma')
  fireEvent.change(screen.getByLabelText('End outcome'), {
    target: { value: 'Verified staging release' }
  })
  fireEvent.change(screen.getByLabelText('Deployment target (optional)'), {
    target: { value: 'Staging web' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(fixture.updateTask).toHaveBeenCalledWith({
      taskId: task.id,
      expectedRevision: 7,
      acceptanceCriteria: 'Verified staging release',
      sequentialSteps: ['Gamma reviews', 'AI drafts'],
      taskPlan: { ...plan, deployment_target: 'Staging web', steps: plan.steps.toReversed() }
    })
  )
})

it('edits the shared brief and step order without rewriting an existing due time', async () => {
  render(<TaskDetailsEditor taskId={task.id} onSaved={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
  await screen.findByLabelText('Notes (optional)')
  fireEvent.change(screen.getByLabelText('Notes (optional)'), {
    target: { value: 'Shared context for people and AI' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
  expect((screen.getByLabelText('Step 1') as HTMLTextAreaElement).value).toBe('Sal reviews')
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(fixture.updateTask).toHaveBeenCalledWith({
      taskId: task.id,
      expectedRevision: 7,
      description: 'Shared context for people and AI',
      sequentialSteps: ['Sal reviews', 'AI drafts'],
      taskPlan: {
        version: 1,
        completion_mode: 'deliverable',
        steps: [
          { id: 'step_2', title: 'Sal reviews', actor_ids: [] },
          { id: 'step_1', title: 'AI drafts', actor_ids: [] }
        ]
      }
    })
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('sends explicit note/date/plan clears and keeps the draft when the server refuses the edit', async () => {
  fixture.updateTask.mockResolvedValue({
    ok: false,
    error: { code: 'revision_conflict', message: 'The task changed elsewhere.' }
  })
  render(<TaskDetailsEditor taskId={task.id} onSaved={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
  await screen.findByLabelText('Notes (optional)')
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Due date (optional)'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('The task changed elsewhere.')
  expect(fixture.updateTask).toHaveBeenCalledWith({
    taskId: task.id,
    expectedRevision: 7,
    description: '',
    dueDate: null,
    sequentialSteps: [],
    taskPlan: { version: 1, completion_mode: 'deliverable', steps: [] }
  })
  expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('')
  expect(screen.queryByLabelText('Step 1')).toBeNull()
})
