// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReviewWaitsResult } from '../../../../shared/artifact-review-waits'
import { useReviewWaits } from './use-review-waits'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), scope: 0 }))
vi.mock('@/lib/session-data-scope', () => ({
  useSessionDataScope: () => String(mocks.scope),
  isSessionDataScopeCurrent: (scope: string) => scope === String(mocks.scope)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))

const waiting: ReviewWaitsResult = {
  status: 'ok',
  inbox: 'ok',
  items: [
    {
      slug: 'plan',
      title: 'Plan',
      question: 'Ship?',
      shareUrl: '',
      status: 'pending',
      revision: 1,
      updatedAt: null,
      publishedBy: null,
      session: null
    }
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.rpc.mockReset()
  mocks.scope += 1
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('removes resolved attention immediately when returning from OmniOS', async () => {
  mocks.rpc.mockResolvedValueOnce(waiting)
  const { result } = renderHook(useReviewWaits)
  await act(async () => {})
  expect(result.current.items).toHaveLength(1)
  mocks.rpc.mockResolvedValue({ status: 'ok', inbox: 'ok', items: [] })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(result.current.items).toEqual([])
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
})

it('serializes polling and focus so an older read cannot overwrite a later one', async () => {
  let finish!: (result: ReviewWaitsResult) => void
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise<ReviewWaitsResult>((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(useReviewWaits)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish(waiting)
  })
  expect(result.current.items).toHaveLength(1)
  mocks.rpc.mockResolvedValue({ status: 'ok', inbox: 'ok', items: [] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(result.current.items).toEqual([])
})

it('keeps the last attention snapshot on a failed refresh', async () => {
  mocks.rpc.mockResolvedValueOnce(waiting)
  const { result } = renderHook(useReviewWaits)
  await act(async () => {})
  mocks.rpc.mockRejectedValueOnce(new Error('offline'))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(result.current.items).toHaveLength(1)
  expect(result.current.inbox).toBe('unavailable')
})

it('preserves a signed-out result instead of reporting an empty healthy inbox', async () => {
  mocks.rpc.mockResolvedValue({ status: 'signed-out' })
  const { result } = renderHook(useReviewWaits)
  await act(async () => {})
  expect(result.current).toMatchObject({
    status: 'signed-out',
    inbox: 'signed-out',
    lastSuccessAt: null
  })
})
