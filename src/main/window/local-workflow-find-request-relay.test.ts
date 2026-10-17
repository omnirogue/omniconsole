import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

const REPLY = 'localWorkflow:findReply'

function createMainWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
    mainFrame: { name: 'main' }
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents
  })
  return { mainWindow, webContents }
}

async function start() {
  const { requestLocalWorkflowFindFromRenderer } =
    await import('./local-workflow-find-request-relay')
  const { mainWindow, webContents } = createMainWindow()
  const pending = requestLocalWorkflowFindFromRenderer(mainWindow as never, 'wt-1', {
    prompt: 'Name the bakery'
  })
  const sent = webContents.send.mock.calls[0] as [string, { requestId: string }]
  return { pending, webContents, mainWindow, channel: sent[0], requestId: sent[1].requestId }
}

describe('requestLocalWorkflowFindFromRenderer', () => {
  beforeEach(() => {
    vi.useRealTimers()
    ipcEmitter.removeAllListeners()
  })

  it("asks the window to start Find the best and takes only that window's answer", async () => {
    const { pending, webContents, channel, requestId } = await start()
    expect(channel).toBe('ui:startLocalWorkflowFind')
    const run = { conversationId: 'find-tab', executionId: '3f9a1c2e-0000-4000-8000-000000000000' }
    const main = { sender: webContents, senderFrame: webContents.mainFrame }
    ipcEmitter.emit(REPLY, { sender: {} }, { requestId, ...run })
    ipcEmitter.emit(REPLY, { sender: webContents, senderFrame: {} }, { requestId, ...run })
    ipcEmitter.emit(REPLY, main, { requestId: 'someone-else', ...run })
    ipcEmitter.emit(REPLY, main, { requestId, ...run })
    await expect(pending).resolves.toEqual(run)
    expect(ipcEmitter.listenerCount(REPLY)).toBe(0)
  })

  it('passes on why the window could not start it, and refuses an answer without a run', async () => {
    const failed = await start()
    const main = { sender: failed.webContents, senderFrame: failed.webContents.mainFrame }
    ipcEmitter.emit(REPLY, main, { requestId: failed.requestId, error: 'No model is set up.' })
    await expect(failed.pending).rejects.toThrow('No model is set up.')
    const empty = await start()
    ipcEmitter.emit(
      REPLY,
      { sender: empty.webContents, senderFrame: empty.webContents.mainFrame },
      { requestId: empty.requestId, conversationId: '', executionId: 'not-a-run' }
    )
    await expect(empty.pending).rejects.toThrow('answered without a run')
  })

  it('stops waiting when the window goes away, or takes too long', async () => {
    const closed = await start()
    closed.mainWindow.emit('closed')
    await expect(closed.pending).rejects.toThrow('closed before Find the best started')
    vi.useFakeTimers()
    const slow = await start()
    const outcome = expect(slow.pending).rejects.toThrow('within two minutes')
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await outcome
    expect(ipcEmitter.listenerCount(REPLY)).toBe(0)
  })
})
