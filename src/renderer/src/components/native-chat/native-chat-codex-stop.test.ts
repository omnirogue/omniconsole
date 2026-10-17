import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  remote: vi.fn(() => false),
  subscribeLocal: vi.fn(),
  subscribeRemote: vi.fn(),
  write: vi.fn(),
  command: vi.fn(),
  cancelQueue: vi.fn(),
  cancelPty: vi.fn(),
  waitIdle: vi.fn()
}))
vi.mock('../terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mocks.subscribeLocal
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: mocks.subscribeRemote
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: mocks.remote,
  sendRuntimePtyInputVerified: mocks.write
}))
vi.mock('./native-chat-runtime-send', () => ({ typeNativeChatCommand: mocks.command }))
vi.mock('@/runtime/runtime-session-input', () => ({
  cancelRuntimeSessionInputVerified: mocks.cancelQueue
}))
vi.mock('./native-chat-pty-send-queue', () => ({
  cancelNativeChatPtySends: mocks.cancelPty,
  waitForNativeChatPtyIdle: mocks.waitIdle
}))

import { stopNativeChatCodex } from './native-chat-codex-stop'

const INTERRUPTED = '■ Conversation interrupted - tell the model what to do differently.'
const BACKGROUND = `${INTERRUPTED}\n1 background terminal running · /ps to view · /stop to close\n› Ask Codex to do anything`
const ACKNOWLEDGED = 'Stopping all background terminals.'

function fixture() {
  let screen: string | null = BACKGROUND
  let watcher = (_data: string): void => {}
  const unsubscribe = vi.fn()
  const controller = new AbortController()
  const args = {
    settings: { activeRuntimeEnvironmentId: 'owner-a' },
    ptyId: 'owned-pty',
    signal: controller.signal,
    timeoutMs: 1_000,
    readTerminalScreen: () => screen
  }
  const subscribe = vi.fn((callback: (data: string) => void) => {
    watcher = callback
    callback(`${INTERRUPTED}\n${ACKNOWLEDGED}`)
    return unsubscribe
  })
  mocks.subscribeLocal.mockImplementation((_ptyId, callback) => subscribe(callback))
  mocks.subscribeRemote.mockImplementation((_settings, _pty, _key, callback) => subscribe(callback))
  mocks.write.mockImplementation(async () => {
    watcher(INTERRUPTED)
    return true
  })
  mocks.command.mockImplementation(async () => {
    watcher(ACKNOWLEDGED)
    return true
  })
  return {
    args,
    controller,
    unsubscribe,
    setScreen: (value: string | null) => {
      screen = value
    },
    emit: (data: string) => watcher(data)
  }
}

describe('stopNativeChatCodex', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.cancelQueue.mockResolvedValue(true)
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => vi.useRealTimers())

  it('interrupts the exact PTY and uses the existing typed /stop path for its advertised background terminals', async () => {
    const current = fixture()
    expect(await stopNativeChatCodex(current.args)).toBe('background-stop-requested')
    expect(mocks.subscribeLocal).toHaveBeenCalledExactlyOnceWith('owned-pty', expect.any(Function))
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(current.args.settings, 'owned-pty', '\x1b')
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith(
      current.args.settings,
      'owned-pty',
      '/stop',
      expect.objectContaining({ aborted: false })
    )
    expect(current.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not mistake replayed output for the current interruption', async () => {
    const current = fixture()
    mocks.write.mockResolvedValue(true)
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('requires fresh command acknowledgment even when its earlier marker is still on screen', async () => {
    const current = fixture()
    current.setScreen(`${ACKNOWLEDGED}\n${BACKGROUND}`)
    mocks.command.mockResolvedValue(true)
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')
    expect(mocks.command).toHaveBeenCalledOnce()
  })

  it('does not send /stop when interruption was rejected', async () => {
    const current = fixture()
    mocks.write.mockResolvedValue(false)
    expect(await stopNativeChatCodex(current.args)).toBe('unverified')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('waits for the current screen to paint the background footer', async () => {
    const current = fixture()
    current.setScreen(null)
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.command).not.toHaveBeenCalled()
    current.setScreen(BACKGROUND)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe('background-stop-requested')
  })

  it('does not invent a background command for an unreadable or unsupported screen', async () => {
    const current = fixture()
    current.setScreen(`${INTERRUPTED}\n1 background terminal running\n› ready`)
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('settles a freshly interrupted turn without background tools after the prompt stabilizes', async () => {
    const current = fixture()
    current.setScreen(`${INTERRUPTED}\n› Ask Codex to do anything`)
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(600)
    expect(await result).toBe('interrupted')
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('does not write into a replacement session after an awaited Escape', async () => {
    const current = fixture()
    let accept!: (value: boolean) => void
    mocks.write.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        })
    )
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.controller.abort()
    current.emit(INTERRUPTED)
    accept(true)
    expect(await result).toBe('cancelled')
    expect(mocks.command).not.toHaveBeenCalled()
    expect(current.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not report a late command acknowledgment after cancellation', async () => {
    const current = fixture()
    let accept!: (value: boolean) => void
    mocks.command.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve
        })
    )
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.controller.abort()
    current.emit(ACKNOWLEDGED)
    accept(true)
    expect(await result).toBe('cancelled')
  })

  it('subscribes at the paired owner live tail and keeps both writes on the captured target', async () => {
    const current = fixture()
    mocks.remote.mockReturnValue(true)
    expect(await stopNativeChatCodex(current.args)).toBe('background-stop-requested')
    expect(mocks.subscribeLocal).not.toHaveBeenCalled()
    expect(mocks.subscribeRemote).toHaveBeenCalledWith(
      current.args.settings,
      'owned-pty',
      'desktop:native-chat-stop:owned-pty',
      expect.any(Function),
      expect.objectContaining({ startAtLiveTail: true })
    )
    expect(mocks.command).toHaveBeenCalledWith(
      current.args.settings,
      'owned-pty',
      '/stop',
      expect.objectContaining({ aborted: false })
    )
  })

  it('awaits cancellation of queued Chat writes before Escape and preserves other input origins', async () => {
    const current = fixture()
    let drained!: () => void
    mocks.cancelQueue.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          drained = () => resolve(true)
        })
    )
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.cancelQueue).toHaveBeenCalledExactlyOnceWith('owned-pty', { origin: 'chat' })
    expect(mocks.write).not.toHaveBeenCalled()
    drained()
    expect(await result).toBe('background-stop-requested')
  })

  it('does not send Escape after the session changes during queued input cancellation', async () => {
    const current = fixture()
    let drained!: () => void
    mocks.cancelQueue.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          drained = () => resolve(true)
        })
    )
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(0)
    current.controller.abort()
    expect(await result).toBe('cancelled')
    drained()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.waitIdle).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('bounds a hung queue cancellation and sends no bytes after its late completion', async () => {
    const current = fixture()
    let drained!: () => void
    mocks.cancelQueue.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          drained = () => resolve(true)
        })
    )
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')
    expect(mocks.write).not.toHaveBeenCalled()

    drained()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('releases an acquired sidecar when a verified write never answers', async () => {
    const current = fixture()
    mocks.write.mockImplementation(() => new Promise<boolean>(() => {}))
    const result = stopNativeChatCodex(current.args)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')
    expect(current.unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('does not send Escape when cancellation of host-queued input is refused', async () => {
    const current = fixture()
    mocks.cancelQueue.mockResolvedValue(false)
    expect(await stopNativeChatCodex(current.args)).toBe('unverified')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('releases an async subscription that settles after the deadline', async () => {
    const current = fixture()
    let subscribed!: (dispose: () => void) => void
    const unsubscribe = vi.fn()
    const result = stopNativeChatCodex({
      ...current.args,
      subscribeToData: () =>
        new Promise<() => void>((resolve) => {
          subscribed = resolve
        })
    })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await result).toBe('unverified')

    subscribed(unsubscribe)
    await vi.advanceTimersByTimeAsync(0)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it.each(['onTransportClose', 'onError', 'onEnd'])(
    'fails closed when the remote stream reports %s after interruption',
    async (callback) => {
      const current = fixture()
      mocks.remote.mockReturnValue(true)
      mocks.write.mockImplementation(async () => {
        current.emit(INTERRUPTED)
        mocks.subscribeRemote.mock.calls[0]![4][callback]()
        return true
      })
      expect(await stopNativeChatCodex(current.args)).toBe('unverified')
      expect(mocks.command).not.toHaveBeenCalled()
    }
  )
})
