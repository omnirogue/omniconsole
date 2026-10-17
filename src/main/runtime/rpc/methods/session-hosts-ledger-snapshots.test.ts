import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { SESSION_HOSTS_LEDGER_SNAPSHOT_METHODS } from './session-hosts-ledger-snapshots'

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }))
vi.mock('../../../session-host-remote/remote-conversation-ledger-runtime', () => ({
  getRemoteConversationLedgerStore: () => ({ snapshots: mocks.snapshots })
}))

const windowContext = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
}

async function call(extra: Record<string, unknown> = windowContext) {
  const method = SESSION_HOSTS_LEDGER_SNAPSHOT_METHODS[0]!
  return method.handler(undefined, { ...extra, runtime: {} } as RpcContext)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.snapshots.mockResolvedValue([{ environmentId: 'env-a', savedAt: 1 }])
})

describe('sessionHosts.ledgerSnapshots', () => {
  it('hands the window its own receiver snapshots', async () => {
    await expect(call()).resolves.toEqual({ snapshots: [{ environmentId: 'env-a', savedAt: 1 }] })
  })

  it('refuses any caller that is not this computer’s window', async () => {
    await expect(call({ ...windowContext, connectionId: 'ws:1' })).rejects.toThrow()
    await expect(call({ ...windowContext, pairedDeviceId: 'phone' })).rejects.toThrow()
    await expect(call({})).rejects.toThrow()
    expect(mocks.snapshots).not.toHaveBeenCalled()
  })
})
