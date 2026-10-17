import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  LOCAL_WORKFLOW_FIND_REPLY_CHANNEL,
  LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL,
  type LocalWorkflowFindReply
} from '../../shared/local-workflow-find-request'
import {
  localWorkflowStartLabel,
  type LocalWorkflowStartAsk
} from '../../shared/local-workflow-run-request'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Opening the conversation, asking the host for its models and admitting the run take seconds. */
const LOCAL_WORKFLOW_FIND_START_MS = 2 * 60_000

/**
 * `omni find-best` and `omni workflow run`: the window opens a workflow conversation for the
 * request and starts it, then answers with the run. Only this window's answer to this request counts.
 */
export async function requestLocalWorkflowFindFromRenderer(
  mainWindow: BrowserWindow,
  worktreeId: string,
  request: LocalWorkflowStartAsk
): Promise<{ conversationId: string; executionId: string }> {
  const label = localWorkflowStartLabel(request)
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error(`${label} needs the OmniConsole window open.`)
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { conversationId: string; executionId: string } | Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener(LOCAL_WORKFLOW_FIND_REPLY_CHANNEL, onReply)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      webContents.removeListener('did-start-loading', onRendererUnavailable)
      if (result instanceof Error) {
        reject(result)
      } else {
        resolve(result)
      }
    }
    const onRendererUnavailable = (): void =>
      finish(new Error(`The OmniConsole window closed before ${label} started.`))
    const onReply = (event: Electron.IpcMainEvent, reply: LocalWorkflowFindReply): void => {
      if (
        event.sender !== webContents ||
        event.senderFrame !== webContents.mainFrame ||
        reply?.requestId !== requestId
      ) {
        return
      }
      if ('error' in reply && typeof reply.error === 'string' && reply.error.trim()) {
        finish(new Error(reply.error.slice(0, 2_000)))
      } else if (
        'conversationId' in reply &&
        typeof reply.conversationId === 'string' &&
        /^[\w:.-]{1,512}$/.test(reply.conversationId) &&
        typeof reply.executionId === 'string' &&
        UUID.test(reply.executionId)
      ) {
        finish({ conversationId: reply.conversationId, executionId: reply.executionId })
      } else {
        finish(new Error('The OmniConsole window answered without a run.'))
      }
    }
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `The OmniConsole window did not start ${label} within two minutes; look for its conversation in the app.`
          )
        ),
      LOCAL_WORKFLOW_FIND_START_MS
    )
    timeout.unref?.()
    ipcMain.on(LOCAL_WORKFLOW_FIND_REPLY_CHANNEL, onReply)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    webContents.once('did-start-loading', onRendererUnavailable)
    try {
      webContents.send(LOCAL_WORKFLOW_FIND_REQUEST_CHANNEL, {
        requestId,
        worktreeId,
        request: { ...request, operationId: request.operationId ?? requestId }
      })
    } catch {
      finish(new Error(`${label} needs the OmniConsole window open.`))
    }
  })
}
