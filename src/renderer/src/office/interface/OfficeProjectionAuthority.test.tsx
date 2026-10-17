// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useCoreStore } from '../integration/store/coreStore'
import type { Task } from '../integration/store/coreStoreTypes'
import type { officeProjectionBackofficeUrl } from '../integration/store/office-projection-backoffice-url'
import { AuditModal } from './AuditModal'
import { KanbanPanel } from './KanbanPanel'

const mocks = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: Parameters<typeof officeProjectionBackofficeUrl>[1]) => unknown
  ) =>
    selector({
      settings: {
        backofficeEnv: 'production',
        backofficeProductionUrl: 'https://omnios.example.com'
      } as AppState['settings'],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: []
    })
}))
vi.mock('./components/Avatar', () => ({ Avatar: () => null }))
vi.mock('./components/InfoBubble', () => ({ InfoBubble: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function task(id: string): Task {
  return {
    id,
    title: id,
    description: 'Customer reply awaiting a recorded decision',
    assignedAgentId: 2,
    status: 'on_hold',
    requiresUserApproval: true,
    draftOutput: 'A response is ready for review',
    revisions: [],
    createdAt: 1,
    updatedAt: 1
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useCoreStore.setState(useCoreStore.getInitialState(), true)
  window.api = { shell: { openUrl: mocks.openUrl } } as unknown as typeof window.api
})
afterEach(cleanup)

describe.each(['sess:ses_customer', 'worktree:customer'])('projected Office row %s', (taskId) => {
  it('shows observed output and an omnios link even when user approval is requested', () => {
    useCoreStore.setState({ tasks: [task(taskId)] })
    render(<AuditModal taskId={taskId} isOpen onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Approve Task' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject with Feedback' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText('COMPLETED WORK')).toBeNull()
    expect(screen.queryByText('Final Output')).toBeNull()
    expect(screen.getByText('Execution observation')).toBeTruthy()
    expect(screen.getByText('Observed output')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'View in omnios' })
    fireEvent.click(link)
    expect(mocks.openUrl).toHaveBeenCalledWith(link.getAttribute('href'))
    expect(useCoreStore.getState().tasks[0].status).toBe('on_hold')
  })

  it('hides local removal in Kanban while preserving it for an ad hoc row', () => {
    useCoreStore.setState({ tasks: [task(taskId), task('task_local')] })
    render(<KanbanPanel />)

    const projectionCard = screen.getByRole('heading', { name: taskId }).parentElement!
      .parentElement!
    const localCard = screen.getByRole('heading', { name: 'task_local' }).parentElement!
      .parentElement!
    expect(within(projectionCard).queryByTitle('Remove task')).toBeNull()
    expect(within(projectionCard).getByRole('link', { name: 'View in omnios' })).toBeTruthy()
    expect(within(localCard).getByTitle('Remove task')).toBeTruthy()
    expect(within(localCard).queryByRole('link', { name: 'View in omnios' })).toBeNull()
  })
})

it('retains working local approval for an ad hoc task', () => {
  useCoreStore.setState({ tasks: [task('task_local')] })
  render(<AuditModal taskId="task_local" isOpen onClose={vi.fn()} />)
  expect(screen.getByRole('textbox')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Approve Task' }))
  expect(useCoreStore.getState().tasks[0]).toMatchObject({
    status: 'done',
    output: 'A response is ready for review'
  })
})
