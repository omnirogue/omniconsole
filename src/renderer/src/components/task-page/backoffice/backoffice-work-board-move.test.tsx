// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BackofficeWorkBoard } from './backoffice-work-board'

const api = vi.hoisted(() => ({
  listWork: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  transitionTask: vi.fn()
}))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
vi.mock('@/components/tasks/NewTaskButton', () => ({ NewTaskButton: () => null }))
vi.mock('@/components/ui/dropdown-menu', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    DropdownMenu: pass,
    DropdownMenuContent: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children?: React.ReactNode
      onSelect?: () => void
    }) => (
      <button onClick={onSelect} {...rest}>
        {children}
      </button>
    )
  }
})
afterEach(cleanup)

it('keeps the card in place through an intermediate poll and waits for the final board read', async () => {
  localStorage.clear()
  const card = {
    id: 'btk_move0001',
    title: 'Shared proposal',
    status: 'open',
    kanban_status: 'backlog',
    tags: ['proposed'],
    kanban_eligible: true,
    source: 'omniconsole-task',
    owner_employee_id: 'emp_sal'
  }
  const board = (tags: string[], kanban_status: string) => ({
    ok: true,
    data: { items: [{ ...card, tags, kanban_status }], total: 1, capped: false, companies: [] }
  })
  api.listWork.mockResolvedValue(board(['proposed'], 'backlog'))
  api.getTask.mockResolvedValue({ ok: true, data: { ...card, state_revision: 2 } })
  api.updateTask.mockResolvedValue({ ok: true, data: {} })
  let finishTransition!: (value: unknown) => void
  api.transitionTask.mockReturnValue(
    new Promise((resolve) => {
      finishTransition = resolve
    })
  )
  render(
    <BackofficeWorkBoard
      scope="move-test"
      viewer="emp_sal"
      rows={[]}
      names={new Map()}
      onOpenTask={vi.fn()}
    />
  )
  await screen.findByText('Shared proposal')
  fireEvent.click(document.querySelector('[data-work-card-move-target="ready"]')!)
  await waitFor(() => expect(api.transitionTask).toHaveBeenCalledTimes(1))
  api.listWork.mockResolvedValue(board([], 'backlog'))
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(api.listWork).toHaveBeenCalledTimes(2))
  expect(
    screen
      .getByText('Shared proposal')
      .closest('[data-work-column]')
      ?.getAttribute('data-work-column')
  ).toBe('proposed')
  expect(
    (screen.getByRole('button', { name: 'Move Shared proposal' }) as HTMLButtonElement).disabled
  ).toBe(true)
  let finishRead!: (value: unknown) => void
  api.listWork.mockReturnValue(
    new Promise((resolve) => {
      finishRead = resolve
    })
  )
  await act(async () => {
    finishTransition({ ok: true, data: {} })
  })
  await waitFor(() => expect(api.listWork).toHaveBeenCalledTimes(3))
  expect(screen.getByText('Moving…')).toBeTruthy()
  await act(async () => {
    finishRead(board([], 'ready'))
  })
  await waitFor(() =>
    expect(
      screen
        .getByText('Shared proposal')
        .closest('[data-work-column]')
        ?.getAttribute('data-work-column')
    ).toBe('ready')
  )
  expect(screen.queryByText('Moving…')).toBeNull()
})
