// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import type { SessionProjectThreadOutput } from '@/lib/session-project-thread-outputs'

const mocks = vi.hoisted(() => ({
  outputs: [] as SessionProjectThreadOutput[],
  send: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))
vi.mock('./use-session-project-review', () => ({
  useSessionProjectOutputs: () => () => mocks.outputs
}))
vi.mock('@/lib/session-reply-send', () => ({ sendSessionReply: mocks.send }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))

import { SessionProjectThreadOutputs } from './SessionProjectThreadOutputs'

const thread = {
  row: { session: { rowKey: 'row', label: 'Fix checkout' } }
} as unknown as SessionProjectThread
const review = (
  checks: 'pending' | 'success' | 'failure' | 'neutral',
  state: 'open' | 'merged' = 'open'
): SessionProjectThreadOutput => ({
  kind: 'review',
  label: '#12',
  url: 'https://github.com/o/r/pull/12',
  state,
  checks
})

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(undefined)
  mocks.success.mockReset()
  mocks.error.mockReset()
})
afterEach(cleanup)

it('shows an open review’s CI on its chip', () => {
  mocks.outputs = [review('pending')]
  render(<SessionProjectThreadOutputs thread={thread} canSend />)
  expect(screen.getByText('PR #12 open · CI running')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Fix CI' })).toBeNull()
})

it('drops CI from a merged review', () => {
  mocks.outputs = [review('failure', 'merged')]
  render(<SessionProjectThreadOutputs thread={thread} canSend />)
  expect(screen.getByText('PR #12 merged')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Fix CI' })).toBeNull()
})

it('Fix CI sends the failing review to its own thread', async () => {
  mocks.outputs = [review('failure')]
  render(<SessionProjectThreadOutputs thread={thread} canSend />)
  expect(screen.getByText('PR #12 open · CI failing')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Fix CI' }))
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Asked Fix checkout to fix CI.'))
  expect(mocks.send).toHaveBeenCalledWith(
    thread.row.session,
    expect.stringContaining('CI is failing on #12 (https://github.com/o/r/pull/12)')
  )
})

it('offers no Fix CI where the thread cannot take a follow-up', () => {
  mocks.outputs = [review('failure')]
  render(<SessionProjectThreadOutputs thread={thread} canSend={false} />)
  expect(screen.queryByRole('button', { name: 'Fix CI' })).toBeNull()
})

it('offers Review on a Ready for review thread’s open review', () => {
  mocks.outputs = [review('success')]
  const onReview = vi.fn()
  const ready = { ...thread, status: 'reviewReady' } as SessionProjectThread
  const view = render(<SessionProjectThreadOutputs thread={ready} canSend onReview={onReview} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  expect(onReview).toHaveBeenCalledWith(ready, mocks.outputs[0])
  view.unmount()
  mocks.outputs = [review('success', 'merged')]
  render(<SessionProjectThreadOutputs thread={ready} canSend onReview={onReview} />)
  expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
})

it('offers no Review while the thread is still working', () => {
  mocks.outputs = [review('success')]
  render(<SessionProjectThreadOutputs thread={thread} canSend onReview={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
})
