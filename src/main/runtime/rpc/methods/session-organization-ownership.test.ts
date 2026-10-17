import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationKeyState
} from '../../../../shared/session-organization-change'
import { SESSION_ORGANIZATION_OWNERSHIP_RPC } from '../../../../shared/session-organization-ownership'
import type { RpcContext, RpcMethod } from '../core'

const state = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => state.dir
}))

const { SESSION_ORGANIZATION_METHODS, SESSION_ORGANIZATION_WINDOW_ONLY_ERROR } =
  await import('./session-organization')
const { SESSION_ORGANIZATION_OWNERSHIP_METHODS } = await import('./session-organization-ownership')
const { sessionOrganizationLedgerFor } =
  await import('../../../session-organization/organization-change-ledger')

const WINDOW = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime',
  connectionId: 'desktop-renderer:1'
} as const

function call<T>(name: string, params: unknown, extra: Partial<RpcContext> = WINDOW): Promise<T> {
  const method = [...SESSION_ORGANIZATION_METHODS, ...SESSION_ORGANIZATION_OWNERSHIP_METHODS].find(
    (entry) => entry.name === name
  ) as RpcMethod
  const parsed = method.params ? method.params.parse(params) : params
  const runtime = {} as RpcContext['runtime']
  return Promise.resolve(method.handler(parsed, { ...extra, runtime } as RpcContext)) as Promise<T>
}

const launch: OrganizationChange = {
  opId: 'filed-1',
  kind: 'move',
  targets: [{ sessionKey: 's1' }],
  value: 'batch',
  executor: { kind: 'launch', source: 'session-prep' },
  reason: 'filed at launch'
}

async function file(change: OrganizationChange, before: unknown[], after: unknown[]) {
  await call(SESSION_ORGANIZATION_RPC.prepare, { change, before })
  await call(SESSION_ORGANIZATION_RPC.settle, { phase: 'applied', change, after })
}

type Keys = { keys: Record<string, OrganizationKeyState> }

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'session-ownership-rpc-'))
})

afterEach(async () => {
  // Why flush first: a history write still in flight would race the directory's removal.
  await sessionOrganizationLedgerFor(state.dir).flush()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('sessionOrganization ownership calls', () => {
  it('answers ownership to the window and the local CLI; only the window changes it', async () => {
    await file(launch, [null], ['batch'])
    for (const extra of [WINDOW, {}]) {
      const snapshot = await call<Keys>(SESSION_ORGANIZATION_OWNERSHIP_RPC.snapshot, {}, extra)
      expect(snapshot.keys.s1?.ownership.placement).toMatchObject({ opId: 'filed-1', by: 'launch' })
    }
    const stamps = { stamps: [{ key: 's1', field: 'placement', opId: 'filed-1', stamp: 42 }] }
    await expect(call(SESSION_ORGANIZATION_OWNERSHIP_RPC.syncStamps, stamps, {})).rejects.toThrow(
      SESSION_ORGANIZATION_WINDOW_ONLY_ERROR
    )
    await expect(
      call(SESSION_ORGANIZATION_OWNERSHIP_RPC.snapshot, {}, { pairedDeviceId: 'p', clientId: 'c' })
    ).rejects.toThrow()
    const stamped = await call<Keys>(SESSION_ORGANIZATION_OWNERSHIP_RPC.syncStamps, stamps)
    expect(stamped.keys.s1?.ownership.placement?.syncStamp).toBe(42)
  })

  it('seeds a 1a batch filing only where nothing is recorded for the placement', async () => {
    await call(SESSION_ORGANIZATION_RPC.settle, {
      phase: 'applied',
      change: {
        ...launch,
        opId: 'mine',
        targets: [{ sessionKey: 'moved' }],
        executor: { kind: 'person', via: 'sidebar' }
      },
      before: ['batch'],
      after: ['batch']
    })
    await call(SESSION_ORGANIZATION_RPC.settle, {
      phase: 'applied',
      change: {
        opId: 'hid',
        kind: 'archive',
        targets: [{ sessionKey: 'archived' }],
        value: true,
        executor: { kind: 'person', via: 'sidebar' }
      },
      before: [false],
      after: [true]
    })
    const at = '2026-09-24T09:00:00.000Z'
    const seeded = await call<Keys>(SESSION_ORGANIZATION_OWNERSHIP_RPC.seed, {
      seeds: ['untouched', 'moved', 'archived'].map((key) => ({
        key,
        value: 'batch',
        batchId: 'b1',
        at
      }))
    })
    expect(Object.keys(seeded.keys).sort()).toEqual(['archived', 'untouched'])
    expect(seeded.keys.untouched?.ownership.placement).toEqual({
      value: 'batch',
      revision: 'seed:b1',
      by: 'launch',
      opId: 'seed:b1',
      at
    })
    // Seeding again changes nothing.
    await expect(
      call<Keys>(SESSION_ORGANIZATION_OWNERSHIP_RPC.seed, {
        seeds: [{ key: 'untouched', value: 'batch', batchId: 'b2', at }]
      })
    ).resolves.toEqual({ keys: {} })
  })

  it('moves a pane’s ownership and history to its provider key', async () => {
    await file({ ...launch, targets: [{ sessionKey: 'pane' }] }, [null], ['batch'])
    const moved = await call<Keys>(SESSION_ORGANIZATION_OWNERSHIP_RPC.migrateKeys, {
      moves: [{ from: 'pane', to: 'provider', placementFrom: true }]
    })
    expect(moved.keys.provider?.ownership.placement).toMatchObject({ opId: 'filed-1' })
    const history = await call<{ entries: { opId: string }[] }>(SESSION_ORGANIZATION_RPC.history, {
      key: 'provider'
    })
    expect(history.entries.map((entry) => entry.opId)).toEqual(['filed-1'])
  })
})
