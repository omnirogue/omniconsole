// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackofficeTaskActivity } from './backoffice-task-activity'
const api = vi.hoisted(() => ({ listTaskActivity: vi.fn(), addTaskNote: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.listTaskActivity.mockResolvedValue({ ok: true, data: [] })
})
it('prevents two clicks from saving two notes and reads back the shared trail', async () => {
  let finish!: (value: unknown) => void
  api.addTaskNote.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<BackofficeTaskActivity taskId="btk_task0001" names={new Map()} />)
  fireEvent.change(screen.getByLabelText('New task note'), {
    target: { value: 'Candidate reviewed' }
  })
  const button = screen.getByRole('button', { name: 'Add note' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(api.addTaskNote).toHaveBeenCalledTimes(1)
  expect(api.addTaskNote).toHaveBeenCalledWith({
    taskId: 'btk_task0001',
    note: 'Candidate reviewed'
  })
  api.listTaskActivity.mockResolvedValue({
    ok: true,
    data: [
      {
        id: 'event1',
        task_id: 'btk_task0001',
        actor: 'emp_sal',
        created_at: '2026-09-13',
        event: 'comment',
        note: 'Candidate reviewed'
      }
    ]
  })
  finish({ ok: true, data: {} })
  await screen.findByText('Candidate reviewed')
  expect(screen.getByText(/A note does not approve/)).toBeTruthy()
})
it('retains an unsaved note and names a failed history read', async () => {
  api.listTaskActivity.mockResolvedValue({
    ok: false,
    error: { code: 'forbidden', message: 'Not permitted' }
  })
  render(<BackofficeTaskActivity taskId="btk_task0001" names={new Map()} />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Not permitted'))
  expect(screen.queryByText('No activity returned.')).toBeNull()
})
