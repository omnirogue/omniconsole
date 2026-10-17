import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestAcknowledgedRendererTabMount } from './renderer-terminal-tab-mount-ack'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

type Listener = (...args: unknown[]) => void

function fakeWindow(answer: (payload: Record<string, unknown>) => [unknown, unknown] | null) {
  const listeners = new Set<Listener>()
  const webContents = {
    send: vi.fn((_channel: string, payload: Record<string, unknown>) => {
      const reply = answer(payload)
      if (reply) {
        queueMicrotask(() => listeners.forEach((listener) => listener(reply[0], reply[1])))
      }
    })
  }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => null,
    onIpc: (_channel, listener) => listeners.add(listener as Listener),
    removeIpcListener: (_channel, listener) => listeners.delete(listener as Listener)
  })
  return { win: { webContents }, listeners }
}

const request = { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1', personOpen: false }

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

describe('acknowledged renderer tab mounts', () => {
  it('resolves with the window outcome for that exact surface', async () => {
    const { win, listeners } = fakeWindow((payload) => [
      { sender: win.webContents },
      { ...payload, outcome: 'mounted' }
    ])

    await expect(requestAcknowledgedRendererTabMount(win, request, 1_000)).resolves.toBe('mounted')
    expect(win.webContents.send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      requestId: expect.any(String)
    })
    expect(listeners.size).toBe(0)
  })

  it('treats an acknowledgement for another surface as not this one', async () => {
    const { win } = fakeWindow((payload) => [
      { sender: win.webContents },
      { ...payload, tabId: 'tab-2', outcome: 'mounted' }
    ])

    await expect(requestAcknowledgedRendererTabMount(win, request, 1_000)).resolves.toBe(
      'tab_not_found'
    )
  })

  it('ignores another window and reports no reply when the window stays silent', async () => {
    vi.useFakeTimers()
    try {
      const { win } = fakeWindow((payload) => [
        { sender: { other: true } },
        { ...payload, outcome: 'mounted' }
      ])
      const pending = requestAcknowledgedRendererTabMount(win, request, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toBe('no-reply')
    } finally {
      vi.useRealTimers()
    }
  })
})
