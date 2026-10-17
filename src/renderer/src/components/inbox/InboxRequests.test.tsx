// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InboxRequests } from './InboxRequests'
import { TooltipProvider } from '@/components/ui/tooltip'

const f = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadMore: vi.fn(),
  rows: [] as unknown[],
  history: {
    scope: 'person',
    messagesMore: false,
    messagesLoadingMore: false,
    messagesHistoryError: null as string | null
  }
}))
vi.mock('@/components/next-step/next-step-actions', () => ({ finishNextStep: vi.fn() }))
// Markdown language lookup needs both i18n members.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', getResourceBundle: () => ({}) }
}))
vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  useBackofficeWorkStore: (select: (state: typeof f.history) => unknown) => select(f.history),
  loadMoreBackofficeMessages: f.loadMore,
  useBackofficeWorkViews: () => ({
    views: { all: f.rows, gaps: [] },
    reads: {
      todo: { phase: 'ready', value: { employeeId: 'emp_me', baseUrl: 'https://fixture.test' } }
    },
    names: new Map(),
    loading: false,
    refresh: f.refresh
  })
}))
vi.mock('@/components/task-page/backoffice/backoffice-work-message-detail', () => ({
  BackofficeWorkMessageDetail: ({ message }: { message: { id: string } }) => (
    <p>Reply to {message.id}</p>
  )
}))
vi.mock('@/components/handoffs/HandoffDetailView', () => ({
  HandoffDetailView: ({ threadId }: { threadId: string }) => <p>Review {threadId}</p>
}))
beforeEach(() => {
  window.localStorage.clear()
  f.history = {
    scope: 'person',
    messagesMore: false,
    messagesLoadingMore: false,
    messagesHistoryError: null
  }
  f.loadMore.mockReset()
  f.rows = [
    {
      key: 'message:one',
      source: 'message',
      title: 'Discussion question',
      kind: 'reply',
      message: { id: 'msg_one', sender_employee_id: 'emp_sender', recipient_employee_id: 'emp_me' },
      nextActor: { kind: 'me' },
      state: 'queued',
      repliesWaiting: 0
    },
    {
      key: 'thread:one',
      source: 'received-handoff',
      title: 'Review proposal',
      kind: 'review',
      thread: { id: 'hth_one', author_employee_id: 'emp_sender', recipient_employee_id: 'emp_me' },
      nextActor: { kind: 'me' },
      state: 'open',
      repliesWaiting: 0
    }
  ]
})

it('exposes older history without making select-visible claim it includes unloaded rows', () => {
  f.history.messagesMore = true
  const { rerender } = render(
    <TooltipProvider>
      <InboxRequests scope="person" kind="messages" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  expect(screen.getByText(/Older messages are available/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))
  expect(f.loadMore).toHaveBeenCalledWith('person')
  f.history.messagesLoadingMore = true
  rerender(
    <TooltipProvider>
      <InboxRequests scope="person" kind="messages" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  expect(
    screen.getByRole('button', { name: 'Loading older messages…' }).hasAttribute('disabled')
  ).toBe(true)
  expect(screen.getByRole('button', { name: 'Select all matching' }).hasAttribute('disabled')).toBe(
    true
  )
})
afterEach(cleanup)
it('keeps handoff requests out of Discussions and opens the original message', () => {
  render(
    <TooltipProvider>
      <InboxRequests scope="person" kind="messages" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  expect(screen.queryByText('Review proposal')).toBeNull()
  fireEvent.click(screen.getByText('Discussion question'))
  expect(screen.getByText('Reply to msg_one')).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Select {{title}}' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete {{title}}' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Deleted messages' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Mark selected complete' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible items' }))
  expect(screen.getByRole('button', { name: 'Delete selected' }).hasAttribute('disabled')).toBe(
    false
  )
})
it('shows handoff requests separately with the existing exact-thread review surface', () => {
  render(
    <TooltipProvider>
      <InboxRequests scope="person" kind="handoffs" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  expect(screen.queryByText('Discussion question')).toBeNull()
  fireEvent.click(screen.getByText('Review proposal'))
  expect(screen.getByText('Review hth_one')).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Select {{title}}' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete {{title}}' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Deleted handoffs' })).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible items' }))
  expect(screen.getByRole('button', { name: 'Delete selected' }).hasAttribute('disabled')).toBe(
    false
  )
  expect(
    screen.getByRole('button', { name: 'Mark selected complete' }).hasAttribute('disabled')
  ).toBe(false)
})

it('filters unread messages, keeps the opened reply visible and permits marking unread again', () => {
  render(
    <TooltipProvider>
      <InboxRequests scope="person" kind="messages" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Unread' }))
  fireEvent.click(screen.getByText('Discussion question'))
  expect(screen.queryByText('Discussion question')).toBeNull()
  expect(screen.getByText('Reply to msg_one')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Unread' }))
  fireEvent.click(screen.getByRole('button', { name: 'Mark as unread' }))
  expect(screen.getByRole('button', { name: 'Mark as read' })).toBeTruthy()
})

it('searches the shared history and preserves the original reply target when cleared', () => {
  render(
    <TooltipProvider>
      <InboxRequests scope="person" kind="messages" onOpenTask={vi.fn()} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByText('Discussion question'))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched' } })
  expect(screen.queryByText('Discussion question')).toBeNull()
  expect(screen.queryByText('Reply to msg_one')).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'emp_sender' } })
  expect(screen.getByText('Discussion question')).toBeTruthy()
  expect(screen.getByText('Reply to msg_one')).toBeTruthy()
  expect(screen.queryByText('Review proposal')).toBeNull()
})
