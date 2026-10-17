// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'
import type { WorkRow } from '../../../../shared/backoffice-work-views'
import { messageRow } from '../../../../shared/backoffice-work-message-rows'
import { inboxRowCanBeUnread, useInboxReadState } from './inbox-read-state'
import { useInboxUnread } from './inbox-unread'

const f = vi.hoisted(() => ({ rows: [] as WorkRow[], viewer: 'emp_me' }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'account-a' }))
vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  useBackofficeWorkViews: () => ({
    views: { all: f.rows },
    reads: { todo: { phase: 'ready', value: { employeeId: f.viewer } } },
    loading: false
  })
}))

function message(patch: Partial<PeerMessageThread> = {}) {
  return messageRow(
    {
      id: 'pm_one',
      project_id: 'product',
      task_id: null,
      sender_session_id: 'app_sender',
      recipient_session_id: 'app_me',
      sender_employee_id: 'emp_sender',
      recipient_employee_id: 'emp_me',
      purpose: 'question',
      summary: 'Can you check this?',
      state: 'queued',
      created_at: 100,
      delivered_at: null,
      replied_at: null,
      resolved_at: null,
      expires_at: null,
      reply: null,
      ...patch
    },
    f.viewer
  )
}

beforeEach(() => {
  window.localStorage.clear()
  f.viewer = 'emp_me'
  f.rows = []
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps read state for the original message and resurfaces a later reply', () => {
  const row = message()
  const { result } = renderHook(() => useInboxReadState('account-a', 'emp_me'))
  expect(result.current.isUnread(row)).toBe(true)
  act(() => result.current.markRead(row))
  expect(result.current.isUnread(row)).toBe(false)
  expect(result.current.isUnread(message({ replied_at: 200 }))).toBe(true)
  act(() => result.current.toggle(row))
  expect(result.current.isUnread(row)).toBe(true)
  expect(row.message?.state).toBe('queued')
})

it('persists across remounts and isolates person, company and environment changes', () => {
  const row = message()
  const original = renderHook(() => useInboxReadState('account-a', 'emp_me'))
  act(() => original.result.current.markRead(row))
  original.unmount()
  const restored = renderHook(() => useInboxReadState('account-a', 'emp_me'))
  expect(restored.result.current.isUnread(row)).toBe(false)
  const otherEnvironment = renderHook(() => useInboxReadState('account-b', 'emp_me'))
  expect(otherEnvironment.result.current.isUnread(row)).toBe(true)
  const otherPerson = renderHook(() => useInboxReadState('account-a', 'emp_sender'))
  expect(otherPerson.result.current.isUnread(row)).toBe(false)
  const reply = message({ reply: { id: 'pm_reply', summary: 'Done', created_at: 100 } })
  expect(otherPerson.result.current.isUnread(reply)).toBe(true)
})

it('does not count an outsider, a sent unanswered message or an expired message', () => {
  expect(inboxRowCanBeUnread(message(), null)).toBe(false)
  expect(inboxRowCanBeUnread(message(), 'emp_outsider')).toBe(false)
  expect(inboxRowCanBeUnread(message(), 'emp_sender')).toBe(false)
  expect(inboxRowCanBeUnread(message({ state: 'expired' }), 'emp_me')).toBe(false)
})

it('shares counts across every project already loaded by Work', () => {
  f.rows = [message(), message({ id: 'pm_two', project_id: 'another-project' })]
  const counts = renderHook(() => useInboxUnread())
  const reader = renderHook(() => useInboxReadState('account-a', 'emp_me'))
  expect(counts.result.current.total).toBe(2)
  act(() => reader.result.current.markRead(f.rows[0]!))
  expect(counts.result.current.messages).toBe(1)
  expect(counts.result.current.handoffs).toBe(0)
})

it('keeps resolved handoffs out of unread unless they have unseen returned entries', () => {
  const row: WorkRow = {
    ...message(),
    message: undefined,
    source: 'received-handoff',
    thread: {
      id: 'hth_one',
      board_task_id: null,
      author_employee_id: 'emp_sender',
      recipient_employee_id: 'emp_me',
      title: 'File review',
      state: 'resolved',
      action: 'review',
      due_at: null,
      parent_thread_id: null,
      delivery_id: null,
      updated: '2026-09-14T20:00:00Z',
      files: [],
      reviews: []
    }
  }
  expect(inboxRowCanBeUnread(row, 'emp_me')).toBe(false)
  expect(inboxRowCanBeUnread({ ...row, repliesWaiting: 1 }, 'emp_me')).toBe(true)
})

it('keeps read controls usable when persistent storage refuses a write', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full')
  })
  const row = message({ id: 'pm_storage' })
  const { result } = renderHook(() => useInboxReadState('storage-refused', 'emp_me'))
  act(() => result.current.markRead(row))
  expect(result.current.isUnread(row)).toBe(false)
})
