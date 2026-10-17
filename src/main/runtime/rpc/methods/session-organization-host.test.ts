import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_ORGANIZATION_HOST_RPC } from '../../../../shared/session-organization-host-schema'
import type { RpcContext, RpcMethod } from '../core'

const state = vi.hoisted(() => ({ dir: '', passes: 0 }))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))
vi.mock('../../../session-organization/steward-sync-main', () => ({
  runStewardSyncSoon: async () => {
    state.passes += 1
    return null
  }
}))

const { SESSION_ORGANIZATION_HOST_METHODS } = await import('./session-organization-host')
const { SESSION_ORGANIZATION_WINDOW_ONLY_ERROR } = await import('./session-organization')
const { sessionOrganizationHostFor } =
  await import('../../../session-organization/host-organization-instance')

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(name: string, params: unknown, extra: Partial<RpcContext> = WINDOW): Promise<T> {
  const method = SESSION_ORGANIZATION_HOST_METHODS.find((entry) => entry.name === name) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  const runtime = {} as RpcContext['runtime']
  return Promise.resolve(method.handler(parsed, { ...extra, runtime } as RpcContext)) as Promise<T>
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'host-organization-rpc-'))
  state.passes = 0
})

afterEach(async () => {
  await sessionOrganizationHostFor(state.dir).flush()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('the window’s headless-organization calls', () => {
  it('answer only this computer’s window', async () => {
    const params: Record<string, unknown> = {
      [SESSION_ORGANIZATION_HOST_RPC.pending]: undefined,
      [SESSION_ORGANIZATION_HOST_RPC.adopted]: { adopted: [], conflicts: [] },
      [SESSION_ORGANIZATION_HOST_RPC.migrate]: { entries: [] }
    }
    for (const name of Object.values(SESSION_ORGANIZATION_HOST_RPC)) {
      await expect(call(name, params[name], { pairedDeviceId: 'phone' })).rejects.toThrow(
        SESSION_ORGANIZATION_WINDOW_ONLY_ERROR
      )
    }
  })

  it('imports the window’s values, then hands out headless changes after a fresh sync pass', async () => {
    const migrated = await call<{ migratedAt: string | null; personOwned: number }>(
      SESSION_ORGANIZATION_HOST_RPC.migrate,
      { entries: [{ key: 'a', values: { placement: 'folder-1' } }], complete: true }
    )
    expect(migrated.migratedAt).not.toBeNull()
    expect(migrated.personOwned).toBe(1)
    expect(
      (await call<{ records: unknown[] }>(SESSION_ORGANIZATION_HOST_RPC.pending, undefined)).records
    ).toEqual([])
    expect(state.passes).toBe(0)

    const host = sessionOrganizationHostFor(state.dir)
    const outcome = await host.apply({
      kind: 'archive',
      targets: [{ sessionKey: 'b' }],
      value: true,
      executor: { kind: 'app', feature: 'auto-archive' }
    })
    expect(outcome).toMatchObject({ status: 'applied', mode: 'headless' })
    const pending = await call<{ records: { opId: string }[] }>(
      SESSION_ORGANIZATION_HOST_RPC.pending,
      undefined
    )
    expect(pending.records.map((record) => record.opId)).toEqual([outcome.opId])
    expect(state.passes).toBe(1)

    await call(SESSION_ORGANIZATION_HOST_RPC.adopted, { adopted: [outcome.opId], conflicts: [] })
    expect(
      (await call<{ records: unknown[] }>(SESSION_ORGANIZATION_HOST_RPC.pending, undefined)).records
    ).toEqual([])
  })
})
