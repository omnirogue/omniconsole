// Renderer side of the session frame log (step 0 of the session-count fix): windows read the flag,
// hear when it flips (no restart), and send batched receiver records that main appends to the same
// file as its owner records.

import { BrowserWindow, ipcMain } from 'electron'
import {
  SESSION_FRAME_LOG_APPEND_CHANNEL,
  SESSION_FRAME_LOG_GET_STATE_CHANNEL,
  SESSION_FRAME_LOG_STATE_CHANNEL,
  type SessionFrameLogState
} from '../../shared/session-frame-log'
import {
  isSessionFrameLogEnabled,
  onSessionFrameLogEnabledChanged
} from '../observability/session-frame-log'
import { appendRendererSessionFrameRecords } from '../observability/session-frame-log-renderer-records'

let unsubscribeBroadcast: (() => void) | null = null

export function registerSessionFrameLogHandlers(): void {
  ipcMain.removeHandler(SESSION_FRAME_LOG_GET_STATE_CHANNEL)
  ipcMain.handle(SESSION_FRAME_LOG_GET_STATE_CHANNEL, (): SessionFrameLogState => ({
    enabled: isSessionFrameLogEnabled()
  }))
  ipcMain.removeAllListeners(SESSION_FRAME_LOG_APPEND_CHANNEL)
  ipcMain.on(SESSION_FRAME_LOG_APPEND_CHANNEL, (event, records: unknown) => {
    const senderId = event?.sender?.id
    appendRendererSessionFrameRecords(records, typeof senderId === 'number' ? senderId : undefined)
  })
  unsubscribeBroadcast?.()
  unsubscribeBroadcast = onSessionFrameLogEnabledChanged((enabled) => {
    // Why every window: a flip is rare and any window may run the session-tabs mirror.
    const state: SessionFrameLogState = { enabled }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(SESSION_FRAME_LOG_STATE_CHANNEL, state)
      }
    }
  })
}
