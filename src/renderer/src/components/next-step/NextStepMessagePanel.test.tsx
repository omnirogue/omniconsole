// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextStepMessagePanel } from './NextStepMessagePanel'
vi.mock('./DiscussionWriteBoundary', () => ({
  DiscussionWriteBoundary: ({ children }: { children: ReactNode }) => children
}))
const scope = vi.hoisted(() => ({ value: 'person-a' }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => scope.value }))
const api = vi.hoisted(() => ({
  postDiscussion: vi.fn(),
  joinDiscussion: vi.fn(),
  replyPeerMessage: vi.fn()
}))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<object>()),
  consoleWorkflowApi: () => api
}))
beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  scope.value = 'person-a'
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const target = { kind: 'room' as const, id: 'room_a', title: 'Review room' }

it('requires an explicit join and retries an uncertain post with the same frozen payload', async () => {
  const onSent = vi.fn()
  api.joinDiscussion.mockResolvedValue({ ok: true, data: {} })
  api.postDiscussion
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'backoffice_unavailable', message: 'Connection lost' }
    })
    .mockResolvedValueOnce({ ok: true, data: { post: { id: 'post_a' } } })
  render(<NextStepMessagePanel messageTarget={target} onSent={onSent} />)
  expect(api.joinDiscussion).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Join discussion' }))
  await screen.findByText('Joined this discussion.')
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Review this version' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await screen.findByText('Connection lost')
  expect((screen.getByLabelText('Note') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
  expect(api.postDiscussion.mock.calls[0]).toEqual(api.postDiscussion.mock.calls[1])
  expect(api.joinDiscussion).toHaveBeenCalledTimes(1)
})
it('answers the original peer message rather than creating a new handoff', async () => {
  api.replyPeerMessage.mockResolvedValue({ ok: true, data: { id: 'reply_a' } })
  render(
    <NextStepMessagePanel
      messageTarget={{ kind: 'peer', id: 'message_original', title: 'Sender' }}
      onSent={vi.fn()}
    />
  )
  expect(screen.queryByText('Join discussion')).toBeNull()
  expect(screen.queryByLabelText('Include final summary')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Reply to original message' }))
  await waitFor(() =>
    expect(api.replyPeerMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message_original', text: 'Answer' })
    )
  )
  expect(api.postDiscussion).not.toHaveBeenCalled()
})
it('ignores a late success after the account-scoped panel unmounts', async () => {
  let finish!: (value: unknown) => void
  api.postDiscussion.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const onSent = vi.fn()
  const view = render(<NextStepMessagePanel messageTarget={target} onSent={onSent} />)
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  view.unmount()
  finish({ ok: true, data: {} })
  await Promise.resolve()
  expect(onSent).not.toHaveBeenCalled()
})

it('recovers the frozen post and join operation after the composer remounts', async () => {
  api.joinDiscussion.mockResolvedValue({ ok: true, data: {} })
  api.postDiscussion
    .mockResolvedValueOnce({
      ok: false,
      error: { code: 'backoffice_unavailable', message: 'Unconfirmed' }
    })
    .mockResolvedValueOnce({ ok: true, data: {} })
  const onSent = vi.fn()
  const first = render(<NextStepMessagePanel messageTarget={target} onSent={onSent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Join discussion' }))
  await screen.findByText('Joined this discussion.')
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Original bytes' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await screen.findByText('Unconfirmed')
  first.unmount()
  render(<NextStepMessagePanel messageTarget={target} onSent={onSent} />)
  expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('Original bytes')
  expect((screen.getByLabelText('Note') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Join discussion' }))
  await screen.findByText('Joined this discussion.')
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
  expect(api.postDiscussion.mock.calls[0]).toEqual(api.postDiscussion.mock.calls[1])
  expect(api.joinDiscussion.mock.calls[0]).toEqual(api.joinDiscussion.mock.calls[1])
  expect(localStorage.getItem('handoff-request-v1:person-a:peer:room:room_a:message')).toBeNull()
})

it('keeps an unconfirmed message private to the original account and restores it on return', async () => {
  api.postDiscussion.mockResolvedValue({
    ok: false,
    error: { code: 'backoffice_unavailable', message: 'Unconfirmed' }
  })
  const view = render(<NextStepMessagePanel messageTarget={target} onSent={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Private pending message' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await screen.findByText('Unconfirmed')
  scope.value = 'person-b'
  view.rerender(<NextStepMessagePanel messageTarget={target} onSent={vi.fn()} />)
  expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('')
  scope.value = 'person-a'
  view.rerender(<NextStepMessagePanel messageTarget={target} onSent={vi.fn()} />)
  expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe('Private pending message')
  expect(api.postDiscussion).toHaveBeenCalledTimes(1)
})

it('blocks sending when saved retry state is corrupt or cannot be persisted', async () => {
  localStorage.setItem('handoff-request-v1:person-a:peer:room:room_a:message', '{broken')
  const view = render(<NextStepMessagePanel messageTarget={target} onSent={vi.fn()} />)
  expect(
    (screen.getByRole('button', { name: 'Post to discussion' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(screen.getByText(/saved request could not be recovered safely/)).toBeTruthy()
  view.unmount()
  localStorage.clear()
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  render(<NextStepMessagePanel messageTarget={target} onSent={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Must persist first' } })
  fireEvent.click(screen.getByRole('button', { name: 'Post to discussion' }))
  await screen.findByText('Storage unavailable')
  expect(api.postDiscussion).not.toHaveBeenCalled()
})
