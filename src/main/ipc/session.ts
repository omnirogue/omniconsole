import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { noteFolderFocused } from '../git/non-repo-folder-verdicts'
import { retireDeletedTerminalTab } from './session-deleted-tab-retirement'

// Why: a focused workspace earns its folder one fresh Git check after a non-repo/missing verdict.
function noteActiveWorktreeFocus(session: Partial<WorkspaceSessionState> | undefined): void {
  const activeWorktreeId = session?.activeWorktreeId
  if (typeof activeWorktreeId === 'string') {
    noteFolderFocused(splitWorktreeIdForFilesystem(activeWorktreeId)?.worktreePath)
  }
}

export function registerSessionHandlers(store: Store): void {
  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
    noteActiveWorktreeFocus(args)
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    store.patchWorkspaceSession(args, hostId)
    noteActiveWorktreeFocus(args)
  })

  // Why: a confirmed delete must also leave main's saved terminal membership, or the row comes
  // back on restart. Local partition only: another host retires the tabs it owns.
  ipcMain.handle('session:retireDeletedTerminalTab', (_event, tabId: unknown) =>
    typeof tabId === 'string' && tabId ? retireDeletedTerminalTab(store, tabId) : false
  )

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    store.flushOrThrow()
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
    store.flush()
    event.returnValue = true
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}
