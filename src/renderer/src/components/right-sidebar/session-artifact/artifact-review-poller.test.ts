import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_REVIEW_POLL_INTERVAL_MS,
  createArtifactReviewPoller
} from './artifact-review-poller'

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

describe('createArtifactReviewPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks at once, then about every 15 s while started', async () => {
    const load = vi.fn().mockResolvedValue({ revision: 1 })
    const onResult = vi.fn()
    const poller = createArtifactReviewPoller({ load, onResult })

    poller.start()
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenLastCalledWith({ revision: 1 })

    load.mockResolvedValue({ revision: 2 })
    await vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS)
    expect(load).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenLastCalledWith({ revision: 2 })
    poller.stop()
  })

  it('stops polling when stopped and drops an answer still in flight', async () => {
    let resolveLoad: (value: string) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve
        })
    )
    const onResult = vi.fn()
    const poller = createArtifactReviewPoller({ load, onResult })

    poller.start()
    poller.stop()
    resolveLoad('late')
    await flush()
    await vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS * 4)

    expect(onResult).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after a failed check and reports it as no answer', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok')
    const onResult = vi.fn()
    const poller = createArtifactReviewPoller({ load, onResult })

    poller.start()
    await flush()
    expect(onResult).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS)
    expect(onResult).toHaveBeenLastCalledWith('ok')
    poller.stop()
  })

  it('restarts cleanly without doubling the schedule', async () => {
    const load = vi.fn().mockResolvedValue('ok')
    const poller = createArtifactReviewPoller({ load, onResult: vi.fn() })

    poller.start()
    await flush()
    poller.stop()
    poller.start()
    await flush()
    expect(load).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(ARTIFACT_REVIEW_POLL_INTERVAL_MS)
    expect(load).toHaveBeenCalledTimes(3)
    poller.stop()
  })
})
