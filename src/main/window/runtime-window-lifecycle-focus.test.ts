import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { app, ipcMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

vi.mock('electron', () => ({
  app: { focus: vi.fn(), isReady: () => true },
  ipcMain: new EventEmitter()
}))
vi.mock('../backoffice/backoffice-execution-observation', () => ({
  postBackofficeExecutionObservation: vi.fn()
}))
vi.mock('../backoffice/backoffice-review-note', () => ({ postBackofficeReviewNote: vi.fn() }))
vi.mock('../runtime/build-review/build-review-service', () => ({
  setBuildReviewNoteReporter: vi.fn()
}))
vi.mock('../console-workflows/console-local-execution-registration', () => ({
  getConsoleLocalExecution: vi.fn()
}))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  ipcMain.removeAllListeners()
})
function harness() {
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '0')
  vi.stubEnv('ORCA_E2E_HEADLESS', '0')
  vi.stubEnv('ORCA_E2E_HEADFUL', '0')
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), {
    id: 1,
    webContents,
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  })
  const runtime = { attachWindow: vi.fn(), setNotifier: vi.fn() }
  registerRuntimeWindowLifecycle(
    window as unknown as BrowserWindow,
    runtime as unknown as OrcaRuntimeService
  )
  const notifier = runtime.setNotifier.mock.calls[0][0] as NonNullable<
    Parameters<OrcaRuntimeService['setNotifier']>[0]
  >
  return { window, notifier, webContents }
}
describe('terminal window activation', () => {
  it('restores and focuses the OS window before sending pane focus', () => {
    const { window, notifier, webContents } = harness()
    notifier.focusTerminal?.('tab-b', 'wt', 'leaf-b')
    expect(app.focus).toHaveBeenCalledWith({ steal: true })
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.focus.mock.invocationCallOrder[0]).toBeLessThan(
      webContents.send.mock.invocationCallOrder[0]
    )
    expect(webContents.send).toHaveBeenCalledWith('ui:focusTerminal', {
      tabId: 'tab-b',
      worktreeId: 'wt',
      leafId: 'leaf-b'
    })
  })
  it('forwards a created terminal’s title origin to the window', async () => {
    const { notifier, webContents } = harness()
    const pending = notifier.revealTerminalSession?.('wt', {
      ptyId: 'pty',
      title: 'Refunds',
      titleOrigin: 'yours'
    })
    const payload = webContents.send.mock.calls[0][1]
    expect(payload).toMatchObject({ title: 'Refunds', titleOrigin: 'yours' })
    ipcMain.emit(
      'terminal:tabCreateReply',
      { sender: webContents },
      { requestId: payload.requestId, tabId: 'tab' }
    )
    await pending
  })
  it.each([true, false])('only activates a PTY reveal with focus=%s', async (focus) => {
    const { window, notifier, webContents } = harness()
    const pending = notifier.revealTerminalSession?.('wt', { ptyId: 'pty', focus })
    const payload = webContents.send.mock.calls[0][1]
    ipcMain.emit(
      'terminal:tabCreateReply',
      { sender: webContents },
      { requestId: payload.requestId, tabId: 'tab' }
    )
    await pending
    expect(window.focus).toHaveBeenCalledTimes(focus ? 1 : 0)
  })
})
