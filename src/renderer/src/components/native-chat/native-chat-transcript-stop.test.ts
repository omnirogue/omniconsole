import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  cancelQueue: vi.fn(),
  cancelPty: vi.fn(),
  waitIdle: vi.fn()
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))
vi.mock('@/runtime/runtime-session-input', () => ({
  cancelRuntimeSessionInputVerified: mocks.cancelQueue
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: mocks.cancelPty,
  waitForNativeChatPtyIdle: mocks.waitIdle
}))

import {
  stopNativeChatTranscript,
  type NativeChatStopSnapshot
} from './native-chat-transcript-stop'

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  timestamp = 1_100
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function fixture() {
  let snapshot: NativeChatStopSnapshot | null = {
    messages: [
      message('user-1', 'user', 'do work', 1_000),
      message('answer-1', 'assistant', 'Partial answer')
    ],
    transcriptLifecycle: { state: 'working', turnId: 'user-1', timestamp: 1_000 }
  }
  const baseline = snapshot
  const controller = new AbortController()
  return {
    baseline,
    controller,
    args: {
      settings: { activeRuntimeEnvironmentId: 'owner-a' },
      ptyId: 'owned-pty',
      signal: controller.signal,
      readSnapshot: () => snapshot,
      timeoutMs: 1_000
    },
    setSnapshot: (value: NativeChatStopSnapshot | null) => {
      snapshot = value
    },
    interrupt: () => {
      snapshot = {
        ...baseline,
        messages: [
          ...baseline.messages,
          message('interrupt-1', 'system', NATIVE_CHAT_INTERRUPTED_STATUS_TEXT, 1_200)
        ],
        transcriptLifecycle: { state: 'interrupted', turnId: 'answer-1', timestamp: 1_200 }
      }
    }
  }
}

describe('native chat transcript Stop confirmation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    mocks.write.mockResolvedValue(true)
    mocks.cancelQueue.mockResolvedValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('cancels queued chat input and waits for fresh provider evidence after one host-accepted Escape', async () => {
    const current = fixture()
    const settled = vi.fn()
    const pending = stopNativeChatTranscript(current.args).then(settled)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.cancelPty).toHaveBeenCalledExactlyOnceWith('owned-pty')
    expect(mocks.cancelQueue).toHaveBeenCalledExactlyOnceWith('owned-pty', { origin: 'chat' })
    expect(mocks.waitIdle).toHaveBeenCalledExactlyOnceWith('owned-pty')
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
      current.args.settings,
      'owned-pty',
      '\x1b',
      { requireAcceptance: true }
    )
    expect(settled).not.toHaveBeenCalled()
    current.interrupt()
    await vi.advanceTimersByTimeAsync(50)
    await pending
    expect(settled).toHaveBeenCalledExactlyOnceWith('interrupted')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('confirms an aborted partial answer from lifecycle metadata without replacing its content', async () => {
    const current = fixture()
    const pending = stopNativeChatTranscript(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.setSnapshot({
      messages: current.baseline.messages,
      transcriptLifecycle: { state: 'interrupted', turnId: 'answer-1', timestamp: 1_200 }
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toBe('interrupted')
    expect(current.baseline.messages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'Partial answer' }
    ])
  })

  it.each(['accepted-only', 'old-history', 'replayed-id', 'assistant-prose'] as const)(
    'keeps %s unverified instead of claiming the turn stopped',
    async (mode) => {
      const current = fixture()
      const old = message('old-interruption', 'system', NATIVE_CHAT_INTERRUPTED_STATUS_TEXT, 500)
      if (mode === 'replayed-id') {
        current.baseline.messages.unshift(old)
      }
      const pending = stopNativeChatTranscript(current.args)
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'old-history') {
        current.setSnapshot({
          messages: [old, ...current.baseline.messages],
          transcriptLifecycle: { state: 'interrupted', turnId: old.id, timestamp: 500 }
        })
      } else if (mode === 'replayed-id') {
        current.setSnapshot({ ...current.baseline, messages: [...current.baseline.messages, old] })
      } else if (mode === 'assistant-prose') {
        current.setSnapshot({
          ...current.baseline,
          messages: [
            ...current.baseline.messages,
            message('claim', 'assistant', NATIVE_CHAT_INTERRUPTED_STATUS_TEXT, 1_200)
          ]
        })
      }
      await vi.advanceTimersByTimeAsync(1_100)
      expect(await pending).toBe('unverified')
      expect(mocks.write).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['rejected', 'error', 'never-acknowledged'] as const)(
    'does not replay an Escape after %s transport delivery',
    async (mode) => {
      const current = fixture()
      if (mode === 'rejected') {
        mocks.write.mockResolvedValue(false)
      } else if (mode === 'error') {
        mocks.write.mockRejectedValue(new Error('SSH contact lost'))
      } else {
        mocks.write.mockReturnValue(new Promise(() => {}))
      }
      const pending = stopNativeChatTranscript(current.args)
      await vi.advanceTimersByTimeAsync(1_100)
      expect(await pending).toBe('unverified')
      expect(mocks.write).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps loss of transcript contact unverified after input acceptance', async () => {
    const current = fixture()
    const pending = stopNativeChatTranscript(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.setSnapshot(null)
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toBe('unverified')
  })

  it('refuses to send Stop when the host cannot confirm cancelling queued submissions', async () => {
    const current = fixture()
    mocks.cancelQueue.mockResolvedValue(false)
    expect(await stopNativeChatTranscript(current.args)).toBe('unverified')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a subsequent user turn and its interruption', async () => {
    const current = fixture()
    const pending = stopNativeChatTranscript(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.setSnapshot({
      messages: [
        ...current.baseline.messages,
        message('user-2', 'user', 'different work', 1_200),
        message('interrupt-2', 'system', NATIVE_CHAT_INTERRUPTED_STATUS_TEXT, 1_300)
      ],
      transcriptLifecycle: { state: 'interrupted', turnId: 'turn-2', timestamp: 1_300 }
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toBe('cancelled')
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'timeout', 'new-turn'] as const)(
    'never writes a delayed Escape after %s while the input queue settles',
    async (mode) => {
      const current = fixture()
      let release!: () => void
      mocks.waitIdle.mockReturnValue(
        new Promise<void>((resolve) => {
          release = resolve
        })
      )
      const pending = stopNativeChatTranscript(current.args)
      await vi.advanceTimersByTimeAsync(0)
      if (mode === 'abort') {
        current.controller.abort()
      } else if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(1_100)
      } else {
        current.setSnapshot({
          ...current.baseline,
          messages: [...current.baseline.messages, message('user-2', 'user', 'next work', 1_200)]
        })
      }
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(await pending).toBe(mode === 'timeout' ? 'unverified' : 'cancelled')
      expect(mocks.write).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not publish late success after aborting an in-flight control write', async () => {
    const current = fixture()
    let acknowledge!: (accepted: boolean) => void
    mocks.write.mockReturnValue(
      new Promise<boolean>((resolve) => {
        acknowledge = resolve
      })
    )
    const pending = stopNativeChatTranscript(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.controller.abort()
    expect(await pending).toBe('cancelled')
    current.interrupt()
    acknowledge(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
