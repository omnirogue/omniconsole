import { randomUUID } from 'node:crypto'
import type { IpcMainEvent } from 'electron'
import {
  TERMINAL_TAB_MOUNT_REPLY_CHANNEL,
  isTerminalTabMountReply,
  type TerminalTabMountOutcome,
  type TerminalTabMountRequestPayload
} from '../../shared/terminal-tab-mount-ack'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'

/** Leaves the window its own mount wait (it replies `mount_timeout`) plus delivery slack. */
export const RENDERER_TAB_MOUNT_ACK_TIMEOUT_MS = 6_000

type MountWindow = {
  webContents: { send: (channel: string, payload: TerminalTabMountRequestPayload) => void }
}

export type AcknowledgedTabMountRequest = {
  worktreeId: string
  tabId: string
  leafId: string
  personOpen: boolean
}

/**
 * Asks the window to background-mount one exact surface and waits for its acknowledgement.
 * Why: the plain mount request is fire-and-forget, so a caller could not tell a mounted pane from
 * a dropped request and would fall back to an invisible runtime-owned process.
 */
export function requestAcknowledgedRendererTabMount(
  win: MountWindow,
  request: AcknowledgedTabMountRequest,
  timeoutMs = RENDERER_TAB_MOUNT_ACK_TIMEOUT_MS
): Promise<TerminalTabMountOutcome | 'no-reply'> {
  const requestId = randomUUID()
  const surface = getRuntimeDesktopSurface()
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: TerminalTabMountOutcome | 'no-reply'): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      surface.removeIpcListener(TERMINAL_TAB_MOUNT_REPLY_CHANNEL, handler)
      resolve(outcome)
    }
    const handler = (event: IpcMainEvent, reply: unknown): void => {
      if (
        event.sender !== (win.webContents as unknown) ||
        !isTerminalTabMountReply(reply) ||
        reply.requestId !== requestId
      ) {
        return
      }
      // Why: an acknowledgement for another surface is not one for this activation.
      if (
        reply.worktreeId !== request.worktreeId ||
        reply.tabId !== request.tabId ||
        (reply.leafId !== undefined && reply.leafId !== request.leafId)
      ) {
        finish('tab_not_found')
        return
      }
      finish(reply.outcome)
    }
    const timer = setTimeout(() => finish('no-reply'), timeoutMs)
    surface.onIpc(TERMINAL_TAB_MOUNT_REPLY_CHANNEL, handler)
    try {
      win.webContents.send('terminal:requestTabMount', {
        worktreeId: request.worktreeId,
        tabId: request.tabId,
        leafId: request.leafId,
        requestId,
        ...(request.personOpen ? { personOpen: true } : {})
      })
    } catch {
      finish('no-reply')
    }
  })
}
