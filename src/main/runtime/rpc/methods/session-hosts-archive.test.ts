import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { SESSION_HOSTS_ARCHIVE_METHODS } from './session-hosts-archive'

const mocks = vi.hoisted(() => ({ read: vi.fn(), archive: vi.fn() }))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: mocks.read
}))
vi.mock('../../../session-host-remote/remote-session-archive', () => ({
  archiveRemoteSession: mocks.archive
}))

const windowContext = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
}
const row = { viewKey: 'owner-session', hostId: 'runtime:laptop', folded: false }
async function call(extra = windowContext) {
  const method = SESSION_HOSTS_ARCHIVE_METHODS[0]!
  return method.handler({ viewKey: row.viewKey, archived: true }, {
    ...extra,
    runtime: {}
  } as RpcContext)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockResolvedValue([row])
  mocks.archive.mockResolvedValue({ kind: 'completed' })
})

describe('a window archive on another computer', () => {
  it('derives the person origin from the authenticated desktop transport', async () => {
    await expect(call()).resolves.toEqual({ status: 'completed' })
    expect(mocks.archive).toHaveBeenCalledWith(
      row,
      true,
      expect.objectContaining({ requester: { kind: 'person', via: 'sidebar' } })
    )
  })

  it('does not allow a websocket client to claim it is a person clicking this window', async () => {
    await expect(call({ ...windowContext, connectionId: 'ws:1' })).rejects.toThrow()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('does not report an unresolved owner operation as completed', async () => {
    mocks.archive.mockResolvedValue({ kind: 'pending', operationId: 'owner-operation' })
    await expect(call()).resolves.toEqual({ status: 'pending', operationId: 'owner-operation' })
  })

  it('refuses a row that disappeared before the owner can be resolved', async () => {
    mocks.read.mockResolvedValue([])
    await expect(call()).rejects.toThrow('could not be verified')
    expect(mocks.archive).not.toHaveBeenCalled()
  })
})
