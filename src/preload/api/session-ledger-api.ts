import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  SESSION_LEDGER_IPC_PREFIX,
  type LedgerLocalSession,
  type SessionLedgerApi
} from '../../shared/session-ledger-contract'

const channel = (name: string): string => `${SESSION_LEDGER_IPC_PREFIX}${name}`

export function createSessionLedgerApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
): SessionLedgerApi {
  return {
    taskLink: (paneKey) => ipc.invoke(channel('task-link'), paneKey),
    now: (scope) => ipc.invoke(channel('now'), scope),
    peers: (ledgerId) => ipc.invoke(channel('peers'), ledgerId),
    localSessions: () => ipc.invoke(channel('local-sessions')),
    setWaiting: (ledgerId, waiting) => ipc.invoke(channel('set-waiting'), ledgerId, waiting),
    linkCard: (paneId, card) => ipc.invoke(channel('link-card'), paneId, card),
    muteRepo: (repo, muted) => ipc.invoke(channel('mute-repo'), repo, muted),
    mutedRepos: () => ipc.invoke(channel('muted-repos')),
    onLocalSessionsChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, rows: unknown): void =>
        callback(Array.isArray(rows) ? (rows as LedgerLocalSession[]) : [])
      ipc.on(channel('local-sessions-changed'), listener)
      return () => {
        ipc.removeListener(channel('local-sessions-changed'), listener)
      }
    }
  }
}
