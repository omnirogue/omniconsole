import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { registerSelfTargetAccessibilityHost } from './self-target-accessibility'

/** Wire the main window into self-targeted computer-use; only the desktop host has one. */
export function registerSelfTargetAccessibilityWindow(mainWindow: BrowserWindow): () => void {
  return registerSelfTargetAccessibilityHost({
    appName: () => app.getName(),
    pid: process.pid,
    isAccessibilitySupportEnabled: () => app.isAccessibilitySupportEnabled(),
    setAccessibilitySupportEnabled: (enabled) => app.setAccessibilitySupportEnabled(enabled),
    window: {
      isDestroyed: () => mainWindow.isDestroyed(),
      isFocused: () => mainWindow.isFocused(),
      focus: () => {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      },
      onceFocused: (listener) => {
        mainWindow.once('focus', listener)
        return () => mainWindow.off('focus', listener)
      }
    },
    log: (message) => console.info('[computer-self-target]', message)
  })
}
