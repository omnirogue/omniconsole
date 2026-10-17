// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useInboxHistorySelection } from './use-inbox-history-selection'
import { EMPTY_WORK_FILTER } from '@/components/task-page/backoffice/backoffice-work-labels'
import { messageRow } from '../../../../shared/backoffice-work-message-rows'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'

const f = vi.hoisted(() => ({
  scope: 'scope-a',
  more: vi.fn(),
  state: {
    scope: 'scope-a',
    messagesMore: true,
    messagesHistoryError: null as string | null,
    messages: { phase: 'ready', value: [] as PeerMessageThread[] }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => f.scope }))
vi.mock('@/components/next-step/next-step-actions', () => ({ finishNextStep: vi.fn() }))
vi.mock('@/components/task-page/backoffice/backoffice-work-store', () => ({
  loadMoreBackofficeMessages: f.more,
  useBackofficeWorkStore: { getState: () => f.state }
}))
vi.mock('./inbox-matching-handoffs', () => ({ enumerateInboxHandoffs: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      args?.[key] === undefined ? match : String(args[key])
    )
}))

const message = (id: string, summary = 'Keep this', recipient = 'emp_me'): PeerMessageThread => ({
  id,
  summary,
  project_id: 'project',
  sender_employee_id: 'emp_sender',
  recipient_employee_id: recipient,
  sender_session_id: '',
  recipient_session_id: '',
  purpose: 'question',
  state: 'delivered',
  created_at: 1,
  delivered_at: 1,
  replied_at: null,
  resolved_at: null,
  expires_at: null,
  reply: null
})
function mount() {
  return renderHook(() =>
    useInboxHistorySelection({
      scope: 'scope-a',
      viewer: 'emp_me',
      kind: 'messages',
      rows: [messageRow(message('newest'), 'emp_me')],
      names: new Map(),
      filter: { ...EMPTY_WORK_FILTER, query: 'Keep' },
      unreadOnly: false,
      isUnread: () => true
    })
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  f.more.mockReset()
  f.scope = 'scope-a'
  f.state = {
    scope: 'scope-a',
    messagesMore: true,
    messagesHistoryError: null,
    messages: { phase: 'ready', value: [message('newest')] }
  }
})
afterEach(cleanup)

it('reads the remaining pages then selects the exact filtered, personal snapshot', async () => {
  f.more
    .mockImplementationOnce(async () => {
      f.state.messages = {
        phase: 'ready',
        value: [...f.state.messages.value, message('ignore', 'Different topic')]
      }
    })
    .mockImplementationOnce(async () => {
      f.state.messages = {
        phase: 'ready',
        value: [
          ...f.state.messages.value,
          message('oldest'),
          message('stranger', 'Keep', 'emp_other')
        ]
      }
      f.state.messagesMore = false
    })
  const { result } = mount()
  await act(async () => {
    await result.current.selectAll()
  })
  expect(f.more).toHaveBeenCalledTimes(2)
  expect(result.current.selectionRequest).toEqual(['message:newest', 'message:oldest'])
  expect(result.current.notice).toBe('Selected all 2 matching items.')
  expect(result.current.busy).toBe(false)
})

it('cancels a running enumeration and labels the confirmed partial selection', async () => {
  let finish!: () => void
  f.more.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { result } = mount()
  let pending!: Promise<void>
  act(() => {
    pending = result.current.selectAll()
  })
  expect(result.current.busy).toBe(true)
  act(() => {
    result.current.cancel()
  })
  await act(async () => {
    finish()
    await pending
  })
  expect(f.more).toHaveBeenCalledTimes(1)
  expect(result.current.selectionRequest).toEqual(['message:newest'])
  expect(result.current.notice).toContain('Loading cancelled.')
  expect(result.current.notice).not.toContain('Selected all')
})

it('keeps a failed page as partial selection without claiming all messages were read', async () => {
  f.more.mockImplementation(async () => {
    f.state.messagesHistoryError = 'Connection lost'
  })
  const { result } = mount()
  await act(async () => {
    await result.current.selectAll()
  })
  expect(result.current.selectionRequest).toEqual(['message:newest'])
  expect(result.current.notice).toContain('Connection lost')
  expect(result.current.notice).not.toContain('Selected all')
})

it('bounds each action and allows a later action to continue from loaded history', async () => {
  f.more.mockImplementation(async () => {
    f.state.messages = {
      phase: 'ready',
      value: [...f.state.messages.value, message(`older_${f.more.mock.calls.length}`)]
    }
  })
  const { result } = mount()
  await act(async () => {
    await result.current.selectAll()
  })
  expect(f.more).toHaveBeenCalledTimes(60)
  expect(result.current.selectionRequest).toHaveLength(61)
  expect(result.current.notice).toContain('60 older pages per project')
  expect(result.current.notice).not.toContain('Selected all')
  f.more.mockImplementationOnce(async () => {
    f.state.messages = { phase: 'ready', value: [...f.state.messages.value, message('last')] }
    f.state.messagesMore = false
  })
  await act(async () => {
    await result.current.selectAll()
  })
  expect(result.current.selectionRequest).toHaveLength(62)
  expect(result.current.notice).toBe('Selected all 62 matching items.')
})

it('does not publish selection after the signed-in scope changes during a read', async () => {
  f.more.mockImplementation(async () => {
    f.scope = 'scope-b'
    f.state.scope = 'scope-b'
  })
  const { result } = mount()
  await act(async () => {
    await result.current.selectAll()
  })
  expect(result.current.selectionRequest).toBeUndefined()
  expect(result.current.notice).toBe('')
})

it('does not reapply the selection snapshot after deletion, preserving manual deselections', async () => {
  f.state.messagesMore = false
  const { result } = mount()
  await act(async () => {
    await result.current.selectAll()
  })
  const request = result.current.selectionRequest
  act(() => {
    result.current.onActionResults([
      { key: 'message:newest', title: 'Keep this', ok: true, message: '' }
    ])
  })
  expect(result.current.selectionRequest).toBe(request)
})
