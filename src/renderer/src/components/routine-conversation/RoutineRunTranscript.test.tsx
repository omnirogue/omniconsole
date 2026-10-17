// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RoutineRunTranscript } from './RoutineRunTranscript'
import type { BoardConversationTurn } from '../../../../shared/console-routine-conversation-contract'

import type * as RoutineConversationDataModule from './routine-conversation-data'
const api = vi.hoisted(() => ({ getConversation: vi.fn(), postMessage: vi.fn() }))
vi.mock('./routine-conversation-data', async (original) => ({
  ...(await original<typeof RoutineConversationDataModule>()),
  conversationApi: () => api
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, string>) =>
    fallback.replace('{{message}}', args?.message ?? '')
}))
const refreshRuns = vi.fn(async () => undefined)
let posted: Map<string, BoardConversationTurn[]>
beforeEach(() => {
  vi.clearAllMocks()
  posted = new Map()
  api.getConversation.mockResolvedValue({ ok: true, data: { ok: true, messages: [] } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function view(active = false, taskId = 'btk_demo') {
  return (
    <RoutineRunTranscript
      key={taskId}
      taskId={taskId}
      active={active}
      refreshRuns={refreshRuns}
      posted={posted}
    />
  )
}
it('attributes only locally acknowledged human turns to You and all other roles to Agent', async () => {
  const own = { id: 'cnv_own', role: 'user', text: 'My message' }
  posted.set('btk_demo', [own])
  api.getConversation.mockResolvedValue({
    ok: true,
    data: {
      ok: true,
      messages: [
        own,
        { id: 'cnv_peer', role: 'user', text: 'Peer message' },
        { role: 'system', text: 'Review update' }
      ]
    }
  })
  render(view())
  await screen.findByText('Peer message')
  expect(screen.getByText('You')).toBeTruthy()
  expect(screen.getByText('Teammate')).toBeTruthy()
  expect(screen.getByText('Agent')).toBeTruthy()
  expect(screen.getAllByText('My message')).toHaveLength(1)
})
it.each([
  [true, false, 'Delivered now'],
  [false, true, 'Queued for the next run'],
  [true, true, 'Delivered now · Queued for the next run'],
  [false, false, 'Message saved.']
])('uses both hub flags %s/%s', async (delivered, queued, notice) => {
  let complete!: (value: unknown) => void
  api.postMessage.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve
    })
  )
  render(view())
  fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'Hello' } })
  fireEvent.click(screen.getByText('Send'))
  expect((screen.getByLabelText('Message the agent') as HTMLTextAreaElement).disabled).toBe(true)
  fireEvent.submit(screen.getByText('Sending…').closest('form')!)
  expect(api.postMessage).toHaveBeenCalledTimes(1)
  await act(async () =>
    complete({
      ok: true,
      data: {
        ok: true,
        payload: {
          id: 'cnv_new',
          content: 'Hello',
          delivered_live: delivered,
          queued_for_next_attempt: queued
        }
      }
    })
  )
  expect(screen.getByText(notice)).toBeTruthy()
  expect(screen.getByText('You')).toBeTruthy()
})
it('shows hub refusal text and preserves the draft', async () => {
  api.postMessage.mockResolvedValue({
    ok: false,
    error: { status: 403, code: 'board_message_forbidden', message: 'Membership changed' }
  })
  render(view())
  fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'Keep me' } })
  fireEvent.click(screen.getByText('Send'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Membership changed'))
  expect((screen.getByLabelText('Message the agent') as HTMLTextAreaElement).value).toBe('Keep me')
})
it('clears the old transcript when switching runs and ignores a late read', async () => {
  api.getConversation.mockResolvedValueOnce({
    ok: true,
    data: { ok: true, messages: [{ text: 'Old run', role: 'user' }] }
  })
  const mounted = render(view())
  await screen.findByText('Old run')
  api.getConversation.mockReturnValue(new Promise(() => {}))
  mounted.rerender(view(false, 'btk_next'))
  expect(screen.queryByText('Old run')).toBeNull()
})
// The next poll is scheduled once React has flushed the read that just settled, so
// every step advances the clock and then lets that flush happen.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}
it('polls only active mounted views and stops when finished or unmounted', async () => {
  vi.useFakeTimers()
  const mounted = render(view(true))
  await advance(0)
  await advance(8000)
  expect(api.getConversation).toHaveBeenCalledTimes(2)
  mounted.rerender(view(false))
  await advance(0)
  const count = api.getConversation.mock.calls.length
  await advance(60000)
  expect(api.getConversation).toHaveBeenCalledTimes(count)
  mounted.unmount()
  await advance(60000)
  expect(api.getConversation).toHaveBeenCalledTimes(count)
})
it('backs off after errors and resets after success', async () => {
  vi.useFakeTimers()
  api.getConversation.mockResolvedValueOnce({
    ok: false,
    error: { code: 'backoffice_unavailable', message: 'Network unavailable' }
  })
  render(view(true))
  await advance(0)
  await advance(8000)
  expect(api.getConversation).toHaveBeenCalledTimes(1)
  await advance(8000)
  expect(api.getConversation).toHaveBeenCalledTimes(2)
  await advance(8000)
  expect(api.getConversation).toHaveBeenCalledTimes(3)
})

it('pauses polling while the document is hidden', async () => {
  vi.useFakeTimers()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  render(view(true))
  await advance(0)
  hidden.mockReturnValue(true)
  fireEvent(document, new Event('visibilitychange'))
  const count = api.getConversation.mock.calls.length
  await advance(60000)
  expect(api.getConversation).toHaveBeenCalledTimes(count)
  hidden.mockReturnValue(false)
  fireEvent(document, new Event('visibilitychange'))
  await advance(0)
  expect(api.getConversation).toHaveBeenCalledTimes(count + 1)
  hidden.mockRestore()
})
