import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainEvent, IpcMain, WebContents } from 'electron'
import {
  SESSION_TRANSFER_ARCHIVE_COMMIT_CHANNEL,
  SESSION_TRANSFER_ARCHIVE_PENDING_CHANNEL,
  SESSION_TRANSFER_ARCHIVE_APPLIED_CHANNEL
} from '../../shared/session-folder-cli-channels'
import {
  commitArchiveDecision,
  pendingArchiveDecisions,
  acknowledgeArchiveDecision
} from './session-transfer-archive-decisions'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'

type Commit = {
  operationId: string
  keys: readonly string[]
  guard: () => boolean
  expiresAt: number
  sender?: BrowserWindow['webContents']
}
const commits = new Map<string, Commit>()
const installed = new WeakSet<object>()

/** The one-shot commit point checks every retained source/ACK fence synchronously in main. */
export function registerTransferArchiveCommit(
  guard: () => boolean,
  expiresAt: number,
  operationId: string,
  keys: readonly string[]
) {
  const token = randomUUID()
  commits.set(token, { guard, expiresAt, operationId, keys: [...keys] })
  return {
    token,
    close: () => {
      commits.delete(token)
    }
  }
}

export function bindTransferArchiveCommit(win: BrowserWindow, token: string): void {
  const surface = getRuntimeDesktopSurface()
  if (!installed.has(surface)) {
    // Keep a default-deny listener after expiry too: late sendSync callers must always get a reply.
    surface.onIpc(
      SESSION_TRANSFER_ARCHIVE_COMMIT_CHANNEL,
      (event: IpcMainEvent, value: unknown, scope: unknown) => {
        event.returnValue = false
        const commit = typeof value === 'string' ? commits.get(value) : undefined
        if (!commit || commit.sender !== event.sender) {
          return
        }
        commits.delete(value as string)
        if (Date.now() >= commit.expiresAt) {
          return
        }
        try {
          event.returnValue =
            typeof scope === 'string' &&
            commitArchiveDecision(commit.operationId, commit.keys, scope, commit.guard)
        } catch {
          event.returnValue = false
        }
      }
    )
    installed.add(surface)
  }
  const commit = commits.get(token)
  if (commit && !commit.sender) {
    commit.sender = win.webContents
  }
}

/** Installed during UI IPC startup so a restart can recover before any new transfer exists. */
export function installTransferArchiveProjectionHandlers(
  ipc: Pick<IpcMain, 'on' | 'removeAllListeners'>,
  trusted: (sender: WebContents) => boolean
): void {
  ipc.removeAllListeners(SESSION_TRANSFER_ARCHIVE_PENDING_CHANNEL)
  ipc.on(SESSION_TRANSFER_ARCHIVE_PENDING_CHANNEL, (event, scope: unknown) => {
    event.returnValue = []
    if (!trusted(event.sender) || typeof scope !== 'string') {
      return
    }
    try {
      event.returnValue = pendingArchiveDecisions(scope)
    } catch {
      event.returnValue = null
    }
  })
  ipc.removeAllListeners(SESSION_TRANSFER_ARCHIVE_APPLIED_CHANNEL)
  ipc.on(
    SESSION_TRANSFER_ARCHIVE_APPLIED_CHANNEL,
    (event, scope: unknown, operationId: unknown) => {
      event.returnValue = false
      if (!trusted(event.sender) || typeof scope !== 'string' || typeof operationId !== 'string') {
        return
      }
      try {
        event.returnValue = acknowledgeArchiveDecision(scope, operationId)
      } catch {
        /* Retain pending projection. */
      }
    }
  )
}
