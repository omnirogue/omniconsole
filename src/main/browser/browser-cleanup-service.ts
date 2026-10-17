import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import type {
  BrowserCleanupIpcReply,
  BrowserCleanupReport,
  BrowserCleanupRequest
} from '../../shared/browser-cleanup'

export class BrowserCleanupService {
  private previews = new Map<string, { windowId: number; report: BrowserCleanupReport }>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async run(request: BrowserCleanupRequest): Promise<BrowserCleanupReport> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) {
      throw new Error('Browser cleanup needs this computer’s OmniConsole window')
    }
    if (request.action === 'preview') {
      const report = await this.send(win, request)
      for (const [token, preview] of this.previews) {
        if (preview.report.expiresAt < Date.now()) {
          this.previews.delete(token)
        }
      }
      if (this.previews.size >= 8) {
        this.previews.delete(this.previews.keys().next().value!)
      }
      this.previews.set(report.token, { windowId: win.webContents.id, report })
      return report
    }
    const preview = this.previews.get(request.token)
    if (
      !preview ||
      preview.windowId !== win.webContents.id ||
      preview.report.expiresAt < Date.now()
    ) {
      throw new Error('Preview expired or its browser host changed. Review the pages again.')
    }
    this.previews.delete(request.token)
    const directory = join(app.getPath('userData'), 'browser-cleanup')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const reopenPath = join(directory, `${preview.report.token}.json`)
    // Persist before closing, including when the window or transport disappears mid-operation.
    await writeFile(reopenPath, JSON.stringify({ state: 'prepared', ...preview.report }, null, 2), {
      mode: 0o600,
      flag: 'wx'
    })
    try {
      const report = await this.send(win, request)
      await writeFile(reopenPath, JSON.stringify({ state: 'finished', ...report }, null, 2), {
        mode: 0o600
      })
      return { ...report, reopenPath }
    } catch (cause) {
      throw new Error(
        `Cleanup result is unconfirmed. Reopen list: ${reopenPath}. Check the remaining pages before retrying.`,
        { cause }
      )
    }
  }

  private send(win: BrowserWindow, request: BrowserCleanupRequest): Promise<BrowserCleanupReport> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:cleanupReply', listener)
        reject(new Error('Browser cleanup timed out. Check the saved reopen list before retrying.'))
      }, 60_000)
      const listener = (event: Electron.IpcMainEvent, reply: BrowserCleanupIpcReply): void => {
        if (event.sender !== win.webContents || reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:cleanupReply', listener)
        if (reply.error || !reply.report) {
          reject(new Error(reply.error ?? 'Browser cleanup returned no report'))
        } else {
          resolve(reply.report)
        }
      }
      ipcMain.on('browser:cleanupReply', listener)
      win.webContents.send('browser:cleanupRequest', { ...request, requestId })
    })
  }
}
