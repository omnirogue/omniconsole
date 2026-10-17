// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { BackofficeActionList } from './BackofficeActionList'
import { runBulkWorkAction } from './backoffice-bulk-actions'
import type * as BulkActions from './backoffice-bulk-actions'

const f = vi.hoisted(() => ({ scope: 'scope-a', invalidate: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => f.scope }))
vi.mock('./backoffice-work-store', () => ({ invalidateBackofficeWork: f.invalidate }))
vi.mock('@/components/next-step/next-step-actions', () => ({ finishNextStep: vi.fn() }))
vi.mock('./backoffice-bulk-actions', async (original) => ({
  ...(await original<typeof BulkActions>()),
  runBulkWorkAction: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      args?.[key] === undefined ? match : String(args[key])
    )
}))
const row = (id: string, sent = false): WorkRow => ({
  key: `thread:${id}`,
  source: sent ? 'sent-handoff' : 'received-handoff',
  taskId: null,
  title: id,
  kind: 'review',
  state: 'open',
  nextActor: sent ? { kind: 'person', id: 'emp_other' } : { kind: 'me' },
  why: null,
  what: null,
  actionLabel: null,
  dueAt: null,
  updatedAt: null,
  repliesWaiting: 0,
  needsYou: !sent,
  waitingFor: sent,
  thread: {
    id: `hth_${id}`,
    board_task_id: null,
    author_employee_id: sent ? 'emp_me' : 'emp_other',
    recipient_employee_id: sent ? 'emp_other' : 'emp_me',
    title: id,
    state: 'open',
    action: null,
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '',
    files: [],
    reviews: []
  }
})
function view(rows: WorkRow[], scope = f.scope, archived = false) {
  return (
    <TooltipProvider>
      <BackofficeActionList
        scope={scope}
        viewer="emp_me"
        rows={rows}
        names={new Map()}
        emptyText="Empty"
        selectedKey={null}
        onSelect={vi.fn()}
        archived={archived}
      />
    </TooltipProvider>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  f.scope = 'scope-a'
  vi.mocked(runBulkWorkAction).mockImplementation(async (rows) =>
    rows.map((item) => ({ key: item.key, title: item.title, ok: true, message: '' }))
  )
})
afterEach(cleanup)

it('accepts an enumerated selection snapshot without deleting or selecting later arrivals', async () => {
  const selectionRequest = ['thread:older']
  const viewSelection = (rows: WorkRow[], selectionPending = false) => (
    <TooltipProvider>
      <BackofficeActionList
        scope={f.scope}
        viewer="emp_me"
        rows={rows}
        names={new Map()}
        emptyText="Empty"
        selectedKey={null}
        onSelect={vi.fn()}
        selectionRequest={selectionRequest}
        selectionPending={selectionPending}
      />
    </TooltipProvider>
  )
  const mounted = render(viewSelection([row('older')], true))
  expect(screen.getByText('1 selected')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Archive selected' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(runBulkWorkAction).not.toHaveBeenCalled()
  mounted.rerender(viewSelection([row('older'), row('arrival')]))
  expect(
    screen.getByRole('checkbox', { name: 'Select arrival' }).getAttribute('aria-checked')
  ).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
  await waitFor(() => expect(runBulkWorkAction).toHaveBeenCalledTimes(1))
  expect(vi.mocked(runBulkWorkAction).mock.calls[0]?.[0].map((item) => item.key)).toEqual([
    'thread:older'
  ])
})

it('shows selection and quick Archive for received and sent handoffs, excluding unrelated rows', () => {
  const other = row('other')
  other.thread!.recipient_employee_id = 'emp_stranger'
  render(view([row('received'), row('sent', true), other]))
  expect(screen.getByRole('checkbox', { name: 'Select received' })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Select sent' })).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: 'Select other' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Archive received' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Archive sent' })).toBeTruthy()
})

it('selects only the current filtered rows and retains hidden selections without acting on them', async () => {
  const first = row('first'),
    second = row('second')
  const mounted = render(view([first, second]))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select first' }))
  mounted.rerender(view([second]))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible items' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mark selected complete' }))
  await waitFor(() => expect(runBulkWorkAction).toHaveBeenCalledTimes(1))
  expect(vi.mocked(runBulkWorkAction).mock.calls[0]?.[0].map((item) => item.key)).toEqual([
    second.key
  ])
  mounted.rerender(view([first, second]))
  expect(screen.getByRole('checkbox', { name: 'Select first' }).getAttribute('aria-checked')).toBe(
    'true'
  )
})

it('reports partial failures, keeps them selected and retries only those still selected', async () => {
  vi.mocked(runBulkWorkAction).mockResolvedValueOnce([
    { key: 'thread:first', title: 'first', ok: true, message: '' },
    { key: 'thread:second', title: 'second', ok: false, message: 'Connection lost' }
  ])
  render(view([row('first'), row('second')]))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible items' }))
  fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
  await screen.findByText('second: Connection lost')
  expect(screen.getByText('Items updated: 1')).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Select first' }).getAttribute('aria-checked')).toBe(
    'false'
  )
  expect(screen.getByRole('checkbox', { name: 'Select second' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
  await waitFor(() => expect(runBulkWorkAction).toHaveBeenCalledTimes(2))
  expect(vi.mocked(runBulkWorkAction).mock.calls[1]?.[0].map((item) => item.key)).toEqual([
    'thread:second'
  ])
})

it('selects a failed quick Archive row for a visible retry', async () => {
  vi.mocked(runBulkWorkAction).mockResolvedValue([
    { key: 'thread:first', title: 'first', ok: false, message: 'Retry later' }
  ])
  render(view([row('first')]))
  fireEvent.click(screen.getByRole('button', { name: 'Archive first' }))
  await screen.findByText('first: Retry later')
  expect(screen.getByRole('checkbox', { name: 'Select first' }).getAttribute('aria-checked')).toBe(
    'true'
  )
})

it('blocks double clicks and selection edits while a batch is in flight', async () => {
  let finish!: (value: []) => void
  vi.mocked(runBulkWorkAction).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(view([row('first')]))
  const archive = screen.getByRole('button', { name: 'Archive first' })
  fireEvent.click(archive)
  fireEvent.click(archive)
  expect(runBulkWorkAction).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('checkbox', { name: 'Select first' }).hasAttribute('disabled')).toBe(true)
  finish([])
  await waitFor(() => expect(screen.queryByText('Updating selected items…')).toBeNull())
})

it('drops selection and old completion effects when the account changes mid-batch', async () => {
  let finish!: (value: []) => void
  vi.mocked(runBulkWorkAction).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const mounted = render(view([row('first')]))
  fireEvent.click(screen.getByRole('button', { name: 'Archive first' }))
  const ownerCurrent = vi.mocked(runBulkWorkAction).mock.calls[0]![2]
  f.scope = 'scope-b'
  mounted.rerender(view([row('second')]))
  expect(ownerCurrent()).toBe(false)
  finish([])
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Select second' }).getAttribute('aria-checked')
    ).toBe('false')
  )
  expect(f.invalidate).not.toHaveBeenCalled()
})

it('restores archived rows through the same selection controls', async () => {
  render(view([row('first')], f.scope, true))
  expect(screen.queryByRole('button', { name: 'Mark selected complete' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible items' }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore selected' }))
  await waitFor(() => expect(runBulkWorkAction).toHaveBeenCalled())
  expect(vi.mocked(runBulkWorkAction).mock.calls[0]?.[1]).toBe('restore')
})
