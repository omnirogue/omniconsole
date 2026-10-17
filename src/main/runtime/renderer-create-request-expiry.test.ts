import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { RuntimeBrowserCommands, type RuntimeBrowserCommandHost } from './omni-runtime-browser'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

const { on, removeListener } = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on, removeListener }, webContents: { fromId: vi.fn() } }))

afterEach(() => {
  vi.useRealTimers()
  setRuntimeDesktopSurface(null)
  vi.clearAllMocks()
})

for (const kind of ['terminal', 'browser'] as const) {
  it(`${kind} sends its existing 10-second deadline and still times out at that deadline`, async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const send = vi.fn()
    const win = { webContents: { send } }
    let create: () => Promise<unknown>
    if (kind === 'terminal') {
      setRuntimeDesktopSurface({
        showNotification: () => false,
        findWindowById: () => win as never,
        onIpc: on,
        removeIpcListener: removeListener
      })
      const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
      Object.assign(runtime, {
        assertGraphReady: vi.fn(),
        getAvailableAuthoritativeWindow: () => win,
        getAuthoritativeWindow: () => win
      })
      create = () => runtime.createTerminal()
    } else {
      const commands = new RuntimeBrowserCommands({
        getAuthoritativeWindow: () => win
      } as unknown as RuntimeBrowserCommandHost)
      create = () =>
        (
          commands as unknown as {
            createBrowserTabInRenderer(
              url: string,
              worktree: undefined,
              profile: undefined,
              partition: undefined
            ): Promise<unknown>
          }
        ).createBrowserTabInRenderer('about:blank', undefined, undefined, undefined)
    }
    const pending = create()
    const failed = expect(pending).rejects.toThrow('creation timed out')
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toMatchObject({
      requestId: expect.any(String),
      expiresAt: 1_010_000
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await failed
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
}
