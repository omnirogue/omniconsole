import { describe, expect, it, vi } from 'vitest'
import { withCodexHomeProcessLock } from './codex-home-process-lock'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('attempt-specific account queue cancellation', () => {
  it('cancels a queued attempt promptly without releasing its predecessor or starting later', async () => {
    const closure = gate()
    const first = withCodexHomeProcessLock('cancel-test', () => closure.promise)
    const controller = new AbortController()
    const spawn = vi.fn(async () => 'must not spawn')
    const queued = withCodexHomeProcessLock('cancel-test', spawn, controller.signal)
    const sibling = vi.fn(async () => 'sibling')
    const last = withCodexHomeProcessLock('cancel-test', sibling)
    controller.abort(new Error('cancelled attempt'))
    await expect(queued).rejects.toThrow('cancelled attempt')
    expect(spawn).not.toHaveBeenCalled()
    expect(sibling).not.toHaveBeenCalled()
    closure.open()
    await first
    await expect(last).resolves.toBe('sibling')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('does not release an admitted attempt before its closure promise settles', async () => {
    const started = gate()
    const closure = gate()
    const controller = new AbortController()
    const running = withCodexHomeProcessLock(
      'running-test',
      async () => {
        started.open()
        await closure.promise
      },
      controller.signal
    )
    await started.promise
    controller.abort()
    const sibling = vi.fn(async () => {})
    const last = withCodexHomeProcessLock('running-test', sibling)
    await Promise.resolve()
    expect(sibling).not.toHaveBeenCalled()
    closure.open()
    await Promise.all([running, last])
    expect(sibling).toHaveBeenCalledOnce()
  })
  it('never admits an already cancelled attempt', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const spawn = vi.fn(async () => {})
    await expect(
      withCodexHomeProcessLock('pre-cancelled-test', spawn, controller.signal)
    ).rejects.toThrow('cancelled')
    expect(spawn).not.toHaveBeenCalled()
  })
})
