import { BrowserWindow, ipcMain } from 'electron'
import { reportAppHealth } from '../app-health/app-health'
import { fetchTeamMemoryStatus } from '../backoffice/console-team-memory-client'
import { isElectronOmniConsoleMcpSignedIn } from '../host/electron-omni-console-mcp-auth'
import {
  TEAM_MEMORY_STATUS_CHANNEL,
  TeamMemoryStatusService
} from '../team-memory/team-memory-status-service'

let service: TeamMemoryStatusService | null = null

function signedIn(): boolean {
  try {
    return isElectronOmniConsoleMcpSignedIn()
  } catch {
    return false
  }
}

export function teamMemoryStatusService(): TeamMemoryStatusService {
  service ??= new TeamMemoryStatusService({
    isSignedIn: signedIn,
    fetchStatus: fetchTeamMemoryStatus,
    reportHealth: reportAppHealth,
    publish: (status) => {
      try {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(TEAM_MEMORY_STATUS_CHANNEL, status)
          }
        }
      } catch {
        // Why: a window mid-teardown must not turn a status push into a startup error.
      }
    }
  })
  return service
}

/** `window.api.teamMemory`: read the kept answer, or ask for a fresh one. */
export function registerTeamMemoryHandlers(): void {
  ipcMain.removeHandler('teamMemory:status')
  ipcMain.handle('teamMemory:status', () => teamMemoryStatusService().status())
  ipcMain.removeHandler('teamMemory:refresh')
  ipcMain.handle('teamMemory:refresh', () => teamMemoryStatusService().refresh())
}

/** After the backoffice settings are synced: the first check, then every 30 minutes. */
export function startTeamMemoryStatusPolling(): void {
  teamMemoryStatusService().start()
}

export function stopTeamMemoryStatusPolling(): void {
  service?.stop()
}
