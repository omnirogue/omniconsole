// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetchSessionArtifactReview: vi.fn() }))
vi.mock('./session-artifact-client', () => ({
  fetchSessionArtifactReview: mocks.fetchSessionArtifactReview
}))

import { ARTIFACT_REVIEW_POLL_INTERVAL_MS } from './artifact-review-poller'
import { useArtifactReview } from './use-artifact-review'

function status(slug: string, revision: number) {
  return { artifact: { slug, revision, review: null }, shareUrl: `https://x/a/${slug}` }
}

describe('useArtifactReview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetchSessionArtifactReview.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not poll while the panel is hidden', async () => {
    renderHook(() => useArtifactReview('plan', false))
    await act(() => vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS * 3))
    expect(mocks.fetchSessionArtifactReview).not.toHaveBeenCalled()
  })

  it('polls while visible and stops as soon as the panel is hidden', async () => {
    mocks.fetchSessionArtifactReview.mockResolvedValue(status('plan', 1))
    const { result, rerender } = renderHook(({ visible }) => useArtifactReview('plan', visible), {
      initialProps: { visible: true }
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current?.artifact.revision).toBe(1)

    mocks.fetchSessionArtifactReview.mockResolvedValue(status('plan', 2))
    await act(() => vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS))
    expect(result.current?.artifact.revision).toBe(2)
    const callsWhileVisible = mocks.fetchSessionArtifactReview.mock.calls.length

    rerender({ visible: false })
    await act(() => vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS * 4))
    expect(mocks.fetchSessionArtifactReview).toHaveBeenCalledTimes(callsWhileVisible)
  })

  it('never shows one artifact’s status under another', async () => {
    mocks.fetchSessionArtifactReview.mockResolvedValue(status('plan', 1))
    const { result, rerender } = renderHook(({ slug }) => useArtifactReview(slug, true), {
      initialProps: { slug: 'plan' }
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current?.artifact.slug).toBe('plan')

    mocks.fetchSessionArtifactReview.mockReturnValue(new Promise(() => {}))
    rerender({ slug: 'other' })
    expect(result.current).toBeNull()
  })
})
