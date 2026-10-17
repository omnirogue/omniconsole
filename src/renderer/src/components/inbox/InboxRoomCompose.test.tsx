// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InboxRoomCompose } from './InboxRoomCompose'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, text: string) => text }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [
    {
      rowKey: 'row',
      sessionKey: 'session',
      worktreeId: 'folder',
      hostId: null,
      tabId: 'tab',
      paneKey: 'pane',
      kind: 'terminal',
      label: 'Login investigation',
      workspaceLabel: 'Omni IDE',
      agent: 'Claude',
      unavailable: false
    }
  ]
}))
const todo = vi.fn()
const prepare = vi.fn()
const feed = vi.fn()
beforeEach(() => {
  prepare.mockReset()
  feed.mockImplementation(async ({ path }: { path: string }) =>
    path.includes('/directory?')
      ? { ok: true, body: { agents } }
      : {
          ok: true,
          body: {
            people: [
              { employee_id: 'emp_sal', name: 'Sal', enrolled: true },
              { employee_id: 'emp_iris', name: 'Iris', enrolled: false },
              { employee_id: 'emp_eve', name: 'Eve', enrolled: true }
            ]
          }
        }
  )
  todo.mockResolvedValue({
    ok: true,
    items: [
      { task_id: 'btk_abcd', title: 'Ship update', project_id: 'proj_one', status: 'in_progress' }
    ],
    truncated: false
  })
  Object.assign(window, { api: { backoffice: { listTodo: todo, feed } } })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
const agents = [
  {
    session_id: 'pc_sal',
    employee_id: 'emp_sal',
    employee_name: 'Sal',
    project_id: 'proj_one',
    provider: 'Claude',
    availability: 'offline',
    endpoint_kind: 'logical_app',
    session_heartbeat_at: null
  }
]
function setup() {
  render(<InboxRoomCompose project="proj_one" agents={agents} close={vi.fn()} prepare={prepare} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Investigate' } })
  fireEvent.change(screen.getByLabelText('What do you need help with?'), {
    target: { value: 'Please assess the blocker' }
  })
}
async function participant() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Participants' }))
  fireEvent.click(await screen.findByRole('option', { name: /Sal/ }))
  await waitFor(() => expect(screen.queryByRole('option', { name: /Sal/ })).not.toBeInTheDocument())
}
it('selects sessions and tasks by name and includes both in the reviewed instruction', async () => {
  setup()
  await participant()
  fireEvent.click(screen.getByRole('combobox', { name: 'Context (optional)' }))
  fireEvent.change(screen.getByPlaceholderText('Search by name…'), { target: { value: 'Login' } })
  fireEvent.click(await screen.findByRole('option', { name: /Login investigation/ }))
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: /Login investigation/ })).not.toBeInTheDocument()
  )
  expect(screen.getByText('Login investigation')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('combobox', { name: 'Context (optional)' }))
  fireEvent.click(screen.getByRole('button', { name: /^Tasks$/ }))
  fireEvent.click(await screen.findByRole('option', { name: /Ship update/ }))

  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  if (screen.queryByRole('button', { name: 'Choose my AI' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  }
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
  const text = prepare.mock.calls[0][0]
  expect(text).toContain('Login investigation')
  expect(text).toContain('btk_abcd')
  expect(text).toContain('emp_sal')
  expect(screen.queryByLabelText('Existing task ID')).not.toBeInTheDocument()
})
it('allows session-only or no context when tasks cannot load', async () => {
  todo.mockRejectedValue(new Error('Tasks unavailable'))
  setup()
  await participant()
  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  if (screen.queryByRole('button', { name: 'Choose my AI' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  }
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0][0]).toContain('"context_references": []')
})
it('requires a participant without creating or sending a room', async () => {
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  if (screen.queryByRole('button', { name: 'Choose my AI' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  }
  expect(await screen.findByRole('alert')).toHaveTextContent('participant')
  expect(prepare).not.toHaveBeenCalled()
})

it('shows the full roster and does not present a logical Inbox as offline', async () => {
  setup()
  fireEvent.click(screen.getByRole('combobox', { name: 'Participants' }))
  expect(await screen.findByRole('option', { name: /Sal/ })).toHaveTextContent(
    'Live activity is not reported'
  )
  expect(screen.getByRole('option', { name: /Iris/ })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('option', { name: /Eve/ })).toHaveTextContent(
    'No AI conversation in this project'
  )
  expect(screen.queryByText(/offline/)).not.toBeInTheDocument()
})
it('shows roster failures and can retry instead of silently showing an empty list', async () => {
  feed.mockResolvedValueOnce({ ok: false, message: 'Roster unavailable' })
  setup()
  fireEvent.click(screen.getByRole('combobox', { name: 'Participants' }))
  expect(await screen.findByText('Roster unavailable')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect(await screen.findByRole('option', { name: /Iris/ })).toBeInTheDocument()
})
it('reloads enrollment so a newly connected colleague becomes selectable', async () => {
  setup()
  fireEvent.click(screen.getByRole('combobox', { name: 'Participants' }))
  expect(await screen.findByRole('option', { name: /Iris/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  feed.mockImplementation(async ({ path }: { path: string }) =>
    path.includes('/directory?')
      ? {
          ok: true,
          body: {
            agents: [
              ...agents,
              {
                ...agents[0],
                employee_id: 'emp_iris',
                employee_name: 'Iris',
                session_id: 'pc_iris'
              }
            ]
          }
        }
      : {
          ok: true,
          body: {
            people: [
              { employee_id: 'emp_sal', name: 'Sal', enrolled: true },
              { employee_id: 'emp_iris', name: 'Iris', enrolled: true }
            ]
          }
        }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  await waitFor(() =>
    expect(screen.getByRole('option', { name: /Iris/ })).toHaveAttribute('aria-disabled', 'false')
  )
  fireEvent.click(screen.getByRole('option', { name: /Iris/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  if (screen.queryByRole('button', { name: 'Choose my AI' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  }
  expect(prepare.mock.calls[0][0]).toContain('emp_iris')
})

it('reviews only public context and preserves edits without dispatching until confirmed', async () => {
  setup()
  await participant()
  fireEvent.click(screen.getByRole('combobox', { name: 'Context (optional)' }))
  fireEvent.click(await screen.findByRole('option', { name: /Login investigation/ }))
  fireEvent.change(screen.getByLabelText('Current progress'), {
    target: { value: 'The callback fails after sign-in.' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  expect(prepare).not.toHaveBeenCalled()
  const preview = screen.getByText(/The callback fails after sign-in\./, { selector: 'pre' })
  expect(preview).toHaveTextContent('Session: Login investigation')
  expect(preview).not.toHaveTextContent('worktreeId')
  expect(preview).not.toHaveTextContent('paneKey')
  expect(preview).not.toHaveTextContent('context_references')
  fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }))
  expect(screen.getByLabelText('Current progress')).toHaveValue('The callback fails after sign-in.')
  expect(prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review AI instruction' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose my AI' }))
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0][0]).toContain('context_references')
  expect(prepare.mock.calls[0][0]).toContain(
    'Only the exact opening_message is approved for sharing'
  )
})
