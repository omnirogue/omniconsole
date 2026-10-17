import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { TOKEN, ID } from '../../shared/room-test-fixtures'

const mocks = vi.hoisted(() => ({ status: vi.fn(), send: vi.fn(), config: vi.fn() }))
vi.mock('./room-config', () => ({ getRoomConfig: mocks.config, configureRoomOrigins: vi.fn() }))
vi.mock('./room-service', () => ({
  RoomService: class {
    config = { key: 'same', isCurrent: () => true }
    credentials = { status: mocks.status }
    client = { send: mocks.send }
  }
}))
import { registerRoomIpc } from './room-ipc'

beforeEach(() => {
  mocks.status.mockReset().mockReturnValue({ state: 'linked', expiresAt: 12345 })
  mocks.config.mockResolvedValue({ key: 'same' })
  mocks.send.mockReset()
})
describe('rooms IPC boundary', () => {
  function setup(trusted = true) {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const handle: IpcMain['handle'] = (name, listener) => {
      handlers.set(name, listener)
    }
    registerRoomIpc({ handle }, { trusted: () => trusted, openBrowser: vi.fn(), publish: vi.fn() })
    return {
      handlers,
      invoke: (name: string, ...args: unknown[]) =>
        handlers.get(`rooms:${name}`)!({} as IpcMainInvokeEvent, ...args)
    }
  }
  it('exposes status but no token, raw transport or connection ticket', async () => {
    const { handlers, invoke } = setup()
    const response = await invoke('status')
    expect(response).toEqual({ ok: true, data: { state: 'linked', expiresAt: 12345 } })
    expect(JSON.stringify(response)).not.toContain(TOKEN)
    expect([...handlers.keys()]).not.toContain('rooms:access')
    expect([...handlers.keys()]).not.toContain('rooms:connectionTicket')
    expect([...handlers.keys()]).not.toContain('rooms:request')
  })
  it('rejects untrusted frames before loading credentials', async () => {
    const { invoke } = setup(false)
    expect(await invoke('status')).toEqual({ ok: false, error: { code: 'forbidden' } })
    expect(mocks.status).not.toHaveBeenCalled()
  })
  it('rejects forged headers and strips exception text at IPC', async () => {
    const { invoke } = setup()
    expect(
      await invoke('send', ID, {
        eventId: ID,
        content: 'hi',
        mentionedUserIds: [],
        targetAgentIds: [],
        headers: { Authorization: TOKEN }
      })
    ).toEqual({ ok: false, error: { code: 'invalid_request' } })
    expect(mocks.send).not.toHaveBeenCalled()
    mocks.status.mockImplementation(() => {
      throw new Error(TOKEN)
    })
    expect(await invoke('status')).toEqual({ ok: false, error: { code: 'network_error' } })
  })
})
