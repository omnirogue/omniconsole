import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import {
  SESSION_FOLDERS_REPLY_CHANNEL,
  SESSION_FOLDERS_REQUEST_CHANNEL
} from '../../shared/session-folder-cli-channels'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  SESSION_FOLDERS_TIMEOUT_ERROR,
  type SessionFolderRendererReply,
  type SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import { bindTransferArchiveCommit } from './session-transfer-archive-commit'

/** Long enough for a `moveSession` that waits for a just-created pane to be listed. */
export const SESSION_FOLDER_REQUEST_TIMEOUT_MS = 20_000

/**
 * Asks the desktop renderer, which owns the Conversations sidebar folders, to list or change
 * them, and resolves with its answer. Mirrors the terminal tab-create request/reply: one
 * request id, a reply accepted only from that window, and a timeout that removes the listener.
 */
export function requestRendererSessionFolders(
  win: BrowserWindow | null,
  request: SessionFolderRelayRequest,
  timeoutMs: number = SESSION_FOLDER_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error(SESSION_FOLDERS_NO_WINDOW_ERROR))
  }
  if (request.kind === 'archiveSessions') {
    bindTransferArchiveCommit(win, request.commitToken)
  }
  const surface = getRuntimeDesktopSurface()
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const handler = (event: IpcMainEvent, reply: SessionFolderRendererReply): void => {
      if (event.sender !== win.webContents || reply?.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      surface.removeIpcListener(SESSION_FOLDERS_REPLY_CHANNEL, handler)
      if (reply.ok) {
        resolve(reply.result)
      } else {
        reject(new Error(reply.error))
      }
    }
    const timer = setTimeout(() => {
      surface.removeIpcListener(SESSION_FOLDERS_REPLY_CHANNEL, handler)
      reject(new Error(SESSION_FOLDERS_TIMEOUT_ERROR))
    }, timeoutMs)
    surface.onIpc(SESSION_FOLDERS_REPLY_CHANNEL, handler)
    win.webContents.send(SESSION_FOLDERS_REQUEST_CHANNEL, { requestId, request })
  })
}
