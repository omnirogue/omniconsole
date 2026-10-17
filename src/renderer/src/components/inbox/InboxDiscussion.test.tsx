// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { InboxDiscussion } from './InboxDiscussion'
vi.mock('@/components/console-workflows/WorkflowComposer', () => ({
  WorkflowComposer: ({
    initialDraft,
    onAdmitted
  }: {
    initialDraft: WorkflowDraft
    onAdmitted: (id: string) => void
  }) => (
    <div>
      <p>{`Draft task: ${initialDraft.taskId}`}</p>
      <button onClick={() => onAdmitted('wf_admitted')}>Simulate admitted receipt</button>
    </div>
  )
}))
vi.mock('@/components/console-workflows/WorkflowDetail', () => ({
  WorkflowDetail: ({ workflowId }: { workflowId: string }) => (
    <p>{`Live workflow: ${workflowId}`}</p>
  )
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const todo = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  todo.mockResolvedValue({
    ok: true,
    items: [
      { task_id: 'btk_abcd', title: 'Current task', project_id: 'proj_one' },
      { task_id: 'btk_else', title: 'Other project', project_id: 'proj_else' }
    ]
  })
  Object.assign(window, { api: { backoffice: { listTodo: todo } } })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
it('prepares a room link only after admission and keeps sending as a separate reviewed step', async () => {
  const prepare = vi.fn()
  render(
    <InboxDiscussion
      project="proj_one"
      roomId="room_one"
      roomName="Release"
      close={vi.fn()}
      prepare={prepare}
    />
  )
  fireEvent.click(screen.getByRole('combobox', { name: 'Existing task' }))
  fireEvent.click(await screen.findByRole('option', { name: /Current task/ }))
  expect(screen.queryByRole('option', { name: /Other project/ })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Expected result'), {
    target: { value: 'Identify unresolved risks' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Configure workflow' }))
  expect(screen.getByText('Draft task: btk_abcd')).toBeInTheDocument()
  expect(prepare).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Review room link' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Simulate admitted receipt' }))
  expect(screen.getByText('Live workflow: wf_admitted')).toBeInTheDocument()
  expect(prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review room link' }))
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0][0]).toContain('wf_admitted')
  expect(prepare.mock.calls[0][0]).toContain('"room_id": "room_one"')
  expect(prepare.mock.calls[0][0]).toContain('Admission alone does not mean its stages have run')
})
it('reopens an existing workflow without creating a new draft or preparing another link', () => {
  const prepare = vi.fn()
  render(
    <InboxDiscussion
      project="proj_one"
      roomId="room_one"
      roomName="Release"
      existingWorkflowId="wf_existing"
      close={vi.fn()}
      prepare={prepare}
    />
  )
  expect(screen.getByText('Live workflow: wf_existing')).toBeInTheDocument()
  expect(todo).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Review room link' })).not.toBeInTheDocument()
})
