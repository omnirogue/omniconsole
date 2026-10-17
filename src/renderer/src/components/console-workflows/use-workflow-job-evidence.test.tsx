// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowJobEvidence } from './use-workflow-job-evidence'

const read = vi.fn()
const response = {
  ok: true,
  data: {
    job_id: 'job_evidence01',
    attempt: 1,
    lease_generation: 2,
    host: 'mw0002',
    provider: 'codex',
    session_id: 'thread_1',
    entries: [],
    next_after: 0,
    has_more: false,
    complete: false
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  read.mockReset().mockResolvedValue(response)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { consoleWorkflows: { readJobEvidence: read } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('job evidence polling lifetime', () => {
  it('cancels a scheduled refresh when the evidence viewer closes', async () => {
    const view = renderHook(() => useWorkflowJobEvidence({ jobId: 'job_evidence01' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.result.current.loading).toBe(false)
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not schedule a refresh when an in-flight read settles after unmount', async () => {
    let settle: (value: typeof response) => void = () => {}
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const view = renderHook(() => useWorkflowJobEvidence({ jobId: 'job_evidence01' }))
    expect(read).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => {
      settle(response)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
