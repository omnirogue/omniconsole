import type { IpcRenderer } from 'electron'
import type { TeamMemoryApi, TeamMemoryStatusView } from '../../shared/team-memory-contract'

/** Main keeps the answer; the renderer reads it and listens for pushes. */
export function createTeamMemoryApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): TeamMemoryApi {
  return {
    status: () => ipc.invoke('teamMemory:status'),
    refresh: () => ipc.invoke('teamMemory:refresh'),
    onStatus: (callback) => {
      const listener = (_event: unknown, payload: unknown): void =>
        callback(payload as TeamMemoryStatusView)
      ipc.on('teamMemory:status', listener)
      return () => {
        ipc.removeListener('teamMemory:status', listener)
      }
    }
  }
}
