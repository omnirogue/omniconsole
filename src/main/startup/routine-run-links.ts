import { app, ipcMain, type BrowserWindow } from 'electron'
import { parseRoutineRunLink, type RoutineRunLink } from '../../shared/routine-run-link'
import { safelyRevealWindow } from '../window/focus-existing-window'
let pending: RoutineRunLink | null = null
export function captureRoutineRunLinks(
  values: readonly string[],
  getWindow: () => BrowserWindow | null
): boolean {
  const target = values.map(parseRoutineRunLink).find(Boolean)
  if (!target) {
    return false
  }
  pending = target
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    safelyRevealWindow(window)
    window.webContents.send('routines:openRun', target)
  }
  return true
}
export function registerRoutineRunLinks(
  getWindow: () => BrowserWindow | null,
  activate: () => void
): void {
  captureRoutineRunLinks(process.argv, getWindow)
  app.on('open-url', (event, value) => {
    if (captureRoutineRunLinks([value], getWindow)) {
      event.preventDefault()
      activate()
    }
  })
  ipcMain.handle('routines:consumePendingOpenRun', () => {
    const target = pending
    pending = null
    return target
  })
}
