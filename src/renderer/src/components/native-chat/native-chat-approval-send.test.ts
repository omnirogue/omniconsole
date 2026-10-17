import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_QUESTION_STEP_MS } from '../../../../shared/native-chat-answer-stepping'

const mocks = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))

import { sendNativeChatApproval } from './native-chat-approval-send'

function start(keys: readonly string[] = ['\x1b[A', '\r']) {
  const isCurrent = vi.fn(() => true)
  const onSettled = vi.fn()
  const handle = sendNativeChatApproval({
    settings: null,
    ptyId: 'pty-owned',
    keys,
    isCurrent,
    onSettled
  })
  return { handle, isCurrent, onSettled }
}

describe('verified native Chat approvals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.write.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the selector acknowledgement and then its pacing gap before Enter', async () => {
    let accept!: (accepted: boolean) => void
    mocks.write.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        accept = resolve
      })
    )
    const { handle, onSettled } = start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.write.mock.calls).toEqual([
      [null, 'pty-owned', '\x1b[A', { requireAcceptance: true }]
    ])
    expect(onSettled).not.toHaveBeenCalled()
    accept(true)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_STEP_MS - 1)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await handle.settled
    expect(mocks.write.mock.calls).toEqual([
      [null, 'pty-owned', '\x1b[A', { requireAcceptance: true }],
      [null, 'pty-owned', '\r', { requireAcceptance: true }]
    ])
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
    expect(handle.wasSubmitted?.()).toBe(true)
  })

  it.each(['rejection', 'transport error'])(
    'never submits after a selector %s',
    async (failure) => {
      if (failure === 'rejection') {
        mocks.write.mockResolvedValueOnce(false)
      } else {
        mocks.write.mockRejectedValueOnce(new Error('owner disconnected'))
      }
      const { handle, onSettled } = start()
      await vi.runAllTimersAsync()
      await handle.settled
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith(null, 'pty-owned', '\x1b[A', {
        requireAcceptance: true
      })
      expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
    }
  )

  it('settles cancellation immediately even while a host acknowledgement is outstanding', async () => {
    let accept!: (accepted: boolean) => void
    mocks.write.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        accept = resolve
      })
    )
    const { handle, onSettled } = start()
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()
    await handle.settled
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
    accept(true)
    await vi.runAllTimersAsync()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('refuses Enter if the request or owning pane changes between keys', async () => {
    const { handle, isCurrent, onSettled } = start()
    await vi.advanceTimersByTimeAsync(0)
    isCurrent.mockReturnValue(false)
    await vi.runAllTimersAsync()
    await handle.settled
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('drops a pending Enter on cancellation during the pacing gap', async () => {
    const { handle, onSettled } = start()
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()
    await vi.runAllTimersAsync()
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('does not replay a rejected Enter', async () => {
    mocks.write.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { handle, onSettled } = start()
    await vi.runAllTimersAsync()
    await handle.settled
    expect(mocks.write).toHaveBeenCalledTimes(2)
    expect(handle.wasSubmitted?.()).toBe(false)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
  })

  it.each(['1', '\x1b'])(
    'verifies a single legacy control %j without clearing or submitting again',
    async (key) => {
      const { handle, onSettled } = start([key])
      await vi.runAllTimersAsync()
      await handle.settled
      expect(mocks.write).toHaveBeenCalledExactlyOnceWith(null, 'pty-owned', key, {
        requireAcceptance: true
      })
      expect(onSettled).toHaveBeenCalledExactlyOnceWith(true)
    }
  )
})
