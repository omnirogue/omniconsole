import { beforeEach, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { createConsoleWorkflowsApi } from '../../preload/api/console-workflows-api'
import { consoleWorkflowClient } from '../backoffice/console-workflow-client'
import { registerConsoleWorkflowHandlers } from './console-workflows'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../backoffice/console-workflow-client', () => ({
  consoleWorkflowClient: {
    getWorkflow: vi.fn(),
    preview: vi.fn(),
    capabilities: vi.fn()
  }
}))

beforeEach(() => vi.clearAllMocks())

it('routes named preload calls through the registered main handlers with data only', async () => {
  registerConsoleWorkflowHandlers()
  const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls)
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error('Unknown IPC channel')
    }
    return handler({} as Electron.IpcMainInvokeEvent, ...args)
  })
  const api = createConsoleWorkflowsApi({ invoke })
  const result = { ok: false as const, error: { code: 'not_found', message: 'No workflow' } }
  vi.mocked(consoleWorkflowClient.getWorkflow).mockResolvedValue(result)
  expect(await api.getWorkflow({ workflowId: 'wf_audit' })).toBe(result)
  expect(consoleWorkflowClient.getWorkflow).toHaveBeenCalledWith({ workflowId: 'wf_audit' })
  for (const name of ['fetch', 'request', 'publishObservation', 'activate', 'currentBearerToken']) {
    expect(api).not.toHaveProperty(name)
  }
  expect(new Set(Object.keys(api).map((name) => `consoleWorkflows:${name}`))).toEqual(
    new Set(handlers.keys())
  )
  expect([...handlers.keys()].every((channel) => channel.startsWith('consoleWorkflows:'))).toBe(
    true
  )
})
