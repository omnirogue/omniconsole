// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetRealStore } from '@/test/mount-on-real-store'
import { SidebarKanbanNavButton } from '@/components/sidebar/SidebarKanbanNavButton'
import KanbanPage from './KanbanPage'

vi.mock('@/components/task-page/backoffice/backoffice-work-task-sheet', () => ({
  BackofficeWorkTaskSheet: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Task details">
      {taskId}
      <button onClick={onClose}>Close task</button>
    </div>
  )
}))

const api = vi.hoisted(() => ({ listWork: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  consoleWorkflowApi: () => api
}))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'person-a' }))
vi.mock('@/lib/session-follow-up-rows', () => ({ useSessionFollowUpRows: () => [] }))

const board = {
  items: [
    {
      id: 'btk_alpha0001',
      title: 'Ship Alpha',
      status: 'in_progress',
      source: 'omniconsole-ide',
      kanban_eligible: true,
      owner_employee_id: 'emp_sal'
    }
  ],
  total: 1,
  capped: false
}

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  resetRealStore()
  api.listWork.mockReset()
  api.listWork.mockResolvedValue({ ok: true, data: board })
})

it('opens the board from the sidebar in one click', () => {
  render(<SidebarKanbanNavButton />)
  expect(useAppStore.getState().activeView).not.toBe('kanban')
  fireEvent.click(screen.getByText('Kanban'))
  // Why the store, not a rendered page: AppWorkspaceShell routes this view to KanbanPage.
  expect(useAppStore.getState().activeView).toBe('kanban')
})

it('mounts the existing board with Proposed and the six outcome columns', async () => {
  render(<KanbanPage />)
  expect(await screen.findByLabelText('Work board')).toBeTruthy()
  for (const column of [
    'proposed',
    'backlog',
    'ready',
    'in-progress',
    'waiting',
    'review',
    'done'
  ]) {
    expect(document.querySelector(`[data-work-column="${column}"]`)).toBeTruthy()
  }
})

it('defaults to the personal My-tasks view', async () => {
  render(<KanbanPage />)
  const owner = (await screen.findByLabelText('Task owner')) as HTMLSelectElement
  expect(owner.value).toBe('mine')
})

it('keeps the sidebar Kanban page open when a task is selected and closed', async () => {
  useAppStore.getState().openKanbanPage()
  render(<KanbanPage />)
  fireEvent.change(await screen.findByLabelText('Task owner'), { target: { value: 'all' } })
  fireEvent.click(await screen.findByText('Ship Alpha'))
  expect(await screen.findByRole('dialog', { name: 'Task details' })).toBeTruthy()
  expect(useAppStore.getState().activeView).toBe('kanban')
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }))
  expect(screen.queryByRole('dialog', { name: 'Task details' })).toBeNull()
  expect(useAppStore.getState().activeView).toBe('kanban')
})
