import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

import {
  captureHungRendererStack,
  installMainWindowRendererHangRecovery,
  RENDERER_HANG_RECOVERY_GRACE_MS,
  RENDERER_HANG_RECOVERY_MAX_PER_WINDOW,
  type RendererHangWindow
} from './main-window-renderer-hang-recovery'

type Listener = (...args: any[]) => void

function makeDebugger(options: { attached?: boolean; pauses?: boolean } = {}) {
  const listeners: Listener[] = []
  let attached = options.attached ?? false
  const dbg = {
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    isAttached: vi.fn(() => attached),
    on: vi.fn((_event: string, listener: Listener) => {
      listeners.push(listener)
    }),
    removeListener: vi.fn((_event: string, listener: Listener) => {
      listeners.splice(listeners.indexOf(listener), 1)
    }),
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Debugger.pause' && options.pauses !== false) {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({}, 'Debugger.paused', {
              callFrames: [
                {
                  functionName: 'reconcileMirrors',
                  url: 'file:///Applications/OmniConsole.app/out/renderer/assets/index-abc.js',
                  location: { lineNumber: 41, columnNumber: 9 }
                },
                { functionName: '', url: '', location: { lineNumber: 0, columnNumber: 0 } }
              ]
            })
          }
        })
      }
      return {}
    })
  }
  return { dbg, listeners }
}

function makeWindow(dbg = makeDebugger().dbg) {
  const handlers: Record<string, Listener> = {}
  const window = {
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: Listener) => {
      handlers[event] = listener
    }),
    webContents: {
      debugger: dbg,
      forcefullyCrashRenderer: vi.fn(),
      isDestroyed: vi.fn(() => false)
    }
  }
  return { window: window as unknown as RendererHangWindow & typeof window, handlers }
}

describe('captureHungRendererStack', () => {
  it('pauses, formats the frames and detaches', async () => {
    const { dbg, listeners } = makeDebugger()
    const stack = await captureHungRendererStack(dbg as never)
    expect(stack).toBe('reconcileMirrors (index-abc.js:42:10)\n<anonymous> (<anonymous>:1:1)')
    expect(dbg.sendCommand).toHaveBeenCalledWith('Debugger.resume')
    expect(dbg.detach).toHaveBeenCalled()
    expect(listeners).toHaveLength(0)
  })

  it('never steals an attached debugger', async () => {
    const { dbg } = makeDebugger({ attached: true })
    await expect(captureHungRendererStack(dbg as never)).resolves.toMatch(/already attached/)
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('times out and still detaches when the pause never lands', async () => {
    const { dbg } = makeDebugger({ pauses: false })
    await expect(captureHungRendererStack(dbg as never, 10)).rejects.toThrow(/timed out/)
    expect(dbg.detach).toHaveBeenCalled()
  })
})

describe('installMainWindowRendererHangRecovery', () => {
  let clock = 0
  beforeEach(() => {
    vi.useFakeTimers()
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function install(window: RendererHangWindow, skip = false) {
    const record = vi.fn()
    const recovery = installMainWindowRendererHangRecovery({
      mainWindow: window,
      shouldSkipRecovery: () => skip,
      now: () => clock,
      record
    })
    return { record, recovery }
  }

  async function hangFor(handlers: Record<string, Listener>, ms: number) {
    handlers.unresponsive()
    clock += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('crashes a renderer that stays hung past the grace so the breaker-guarded reload runs', async () => {
    const { window, handlers } = makeWindow()
    const { record } = install(window)
    await hangFor(handlers, RENDERER_HANG_RECOVERY_GRACE_MS)
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith('renderer_hang_recovery', {
      unresponsiveMs: RENDERER_HANG_RECOVERY_GRACE_MS
    })
    expect(record).toHaveBeenCalledWith('renderer_hang_stack', {
      stack: expect.stringContaining('reconcileMirrors')
    })
  })

  it('leaves a renderer that recovers on its own alone', () => {
    const { window, handlers } = makeWindow()
    const { record } = install(window)
    handlers.unresponsive()
    clock += 5_000
    handlers.responsive()
    vi.advanceTimersByTime(RENDERER_HANG_RECOVERY_GRACE_MS)
    expect(window.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith('renderer_responsive_again', { unresponsiveMs: 5_000 })
  })

  it('does not recover while the window closes or the app quits', async () => {
    const { window, handlers } = makeWindow()
    install(window, true)
    await hangFor(handlers, RENDERER_HANG_RECOVERY_GRACE_MS)
    expect(window.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  it('stops auto-recovering a renderer that hangs on every load', async () => {
    const { window, handlers } = makeWindow()
    const { record } = install(window)
    for (let i = 0; i <= RENDERER_HANG_RECOVERY_MAX_PER_WINDOW; i++) {
      await hangFor(handlers, RENDERER_HANG_RECOVERY_GRACE_MS)
    }
    expect(window.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(
      RENDERER_HANG_RECOVERY_MAX_PER_WINDOW
    )
    expect(record).toHaveBeenCalledWith(
      'renderer_hang_recovery_suppressed',
      expect.objectContaining({ recentRecoveries: RENDERER_HANG_RECOVERY_MAX_PER_WINDOW })
    )
  })

  it('stops its timer and ignores later events after dispose', () => {
    const { window, handlers } = makeWindow()
    const { recovery, record } = install(window)
    handlers.unresponsive()
    recovery.dispose()
    vi.advanceTimersByTime(RENDERER_HANG_RECOVERY_GRACE_MS)
    record.mockClear()
    handlers.unresponsive()
    vi.advanceTimersByTime(RENDERER_HANG_RECOVERY_GRACE_MS)
    expect(window.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })
})
