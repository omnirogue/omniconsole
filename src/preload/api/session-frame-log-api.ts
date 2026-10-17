import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  SESSION_FRAME_LOG_APPEND_CHANNEL,
  SESSION_FRAME_LOG_GET_STATE_CHANNEL,
  SESSION_FRAME_LOG_STATE_CHANNEL,
  type SessionFrameLogRecord,
  type SessionFrameLogState
} from '../../shared/session-frame-log'

/** Session frame log (session-count fix step 0); absent in the web client, which logs nothing. */
export type SessionFrameLogApi = {
  getState: () => Promise<SessionFrameLogState>
  onStateChanged: (callback: (state: SessionFrameLogState) => void) => () => void
  /** Fire-and-forget batch; main drops records while the log is off. */
  append: (records: SessionFrameLogRecord[]) => void
}

export function createSessionFrameLogApi(
  ipc: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener' | 'send'>
): SessionFrameLogApi {
  return {
    getState: () => ipc.invoke(SESSION_FRAME_LOG_GET_STATE_CHANNEL),
    onStateChanged: (callback) => {
      const listener = (_event: IpcRendererEvent, state: unknown): void =>
        callback({ enabled: (state as { enabled?: unknown } | null)?.enabled === true })
      ipc.on(SESSION_FRAME_LOG_STATE_CHANNEL, listener)
      return () => {
        ipc.removeListener(SESSION_FRAME_LOG_STATE_CHANNEL, listener)
      }
    },
    append: (records) => ipc.send(SESSION_FRAME_LOG_APPEND_CHANNEL, records)
  }
}
