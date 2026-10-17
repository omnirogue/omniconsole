// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BackofficeArchivedHandoffs } from './BackofficeArchivedHandoffs'

const f = vi.hoisted(() => ({
  scope: 'scope-a',
  list: vi.fn(),
  get: vi.fn(),
  archive: vi.fn(),
  invalidate: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => f.scope }))
vi.mock('./backoffice-work-store', () => ({ invalidateBackofficeWork: f.invalidate }))
vi.mock('@/components/next-step/next-step-actions', () => ({ finishNextStep: vi.fn() }))
vi.mock('@/components/handoffs/handoff-client', () => ({ handoffApi: () => f }))
vi.mock('@/components/handoffs/HandoffDetailView', () => ({
  HandoffDetailView: ({ threadId }: { threadId: string }) => <p>Detail {threadId}</p>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      args?.[key] === undefined ? match : String(args[key])
    )
}))
const thread = {
  id: 'hth_archived',
  title: 'Archived proposal',
  board_task_id: null,
  author_employee_id: 'emp_other',
  recipient_employee_id: 'emp_me',
  state: 'open',
  action: null,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '',
  files: [],
  reviews: []
}
const queue = (view = 'archived', assignee = 'emp_me', threads = [thread]) => ({
  ok: true,
  data: { view, assignee, threads, next_cursor: null }
})
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  f.scope = 'scope-a'
  f.list.mockResolvedValue(queue())
  f.get.mockResolvedValue({ ok: true, data: { thread, entries: [], files: [], reviews: [] } })
  f.archive.mockResolvedValue({
    ok: true,
    data: { thread_id: thread.id, employee_id: 'emp_me', archived: false }
  })
})
afterEach(cleanup)
function view(scope = f.scope) {
  return (
    <TooltipProvider>
      <BackofficeArchivedHandoffs scope={scope} viewer="emp_me" names={new Map()} />
    </TooltipProvider>
  )
}
it('reads archived handoffs on demand and restores a selected item through the existing archive verb', async () => {
  render(view())
  expect(f.list).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Archived handoffs' }))
  const panel = screen.getByRole('dialog')
  await within(panel).findByText('Archived proposal')
  expect(f.list).toHaveBeenCalledWith({ view: 'archived' })
  fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select all visible items' }))
  f.list.mockResolvedValue(queue('archived', 'emp_me', []))
  fireEvent.click(within(panel).getByRole('button', { name: 'Restore selected' }))
  await waitFor(() =>
    expect(f.archive).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: thread.id, archived: false })
    )
  )
  await within(panel).findByText('No archived handoffs match this view.')
  expect(f.invalidate).toHaveBeenCalled()
})

it('searches the archived list and opens the same identified handoff detail', async () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Archived handoffs' }))
  await screen.findByText('Archived proposal')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.queryByText('Archived proposal')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'proposal' } })
  fireEvent.click(screen.getByText('Archived proposal'))
  expect(screen.getByText('Detail hth_archived')).toBeTruthy()
})

it.each([
  ['received', 'emp_me'],
  ['archived', 'emp_other']
])('refuses an ignored view or another viewer (%s, %s)', async (kind, viewer) => {
  f.list.mockResolvedValue(queue(kind, viewer))
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Archived handoffs' }))
  await screen.findByRole('alert')
  expect(screen.queryByText('Archived proposal')).toBeNull()
})

it('drops a late archived read when the account scope changes', async () => {
  let finish!: (value: ReturnType<typeof queue>) => void
  f.list.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const mounted = render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Archived handoffs' }))
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(1))
  f.scope = 'scope-b'
  f.list.mockResolvedValue(queue('archived', 'emp_me', []))
  mounted.rerender(view())
  finish(queue())
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('Archived proposal')).toBeNull()
})
