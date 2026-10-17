import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import { createSessionFoldersStore, useSessionFolders } from '@/store/session-folders'
import {
  createSessionOrganizationOwnershipStore,
  useSessionOrganizationOwnership
} from '@/store/session-organization-ownership'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type {
  OrganizationChange,
  OrganizationExecutor,
  OrganizationRecord,
  OrganizationTarget
} from '../../../shared/session-organization-change'
import { SESSION_ORGANIZATION_OWNERSHIP_RPC } from '../../../shared/session-organization-ownership'
import type { SessionBatchOrigins } from './session-batch-origins'
import { applyOrganizationChange, type OrganizationRpc } from './session-organization-change'
import {
  batchLaunchSeeds,
  checkOwnedRevision,
  refreshSessionOrganizationOwnership
} from './session-organization-ownership'
import type { OrganizationStores } from './session-organization-values'
import type { SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const CHECKOUT = '00000000-0000-4000-8000-000000000002'
const BATCH = '00000000-0000-4000-8000-000000000003'
const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Ads review' }

function createStores(membership: Record<string, string>): OrganizationStores {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CHECKOUT, name: 'Checkout' },
      { id: BATCH, name: 'Launch · 09:25' }
    ],
    membership
  }
  const folders = createSessionFoldersStore({ save: vi.fn(), load: vi.fn(() => initial) })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  folders.getState().load()
  view.getState().load()
  return { folders, view }
}

function agentFiled(key: string, folder: string): OrganizationRecord {
  return {
    opId: 'agent',
    kind: 'move',
    targets: [{ sessionKey: key }],
    value: folder,
    executor: PANE,
    phase: 'applied',
    ts: '2026-09-25T10:00:00.000Z',
    revision: 'agent',
    before: [SALES],
    after: [folder]
  }
}

function setup() {
  const stores = createStores({ s1: CHECKOUT })
  const mirror = createSessionOrganizationOwnershipStore(() => {
    throw new Error('no storage in this test')
  })
  mirror.getState().applyRecord(agentFiled('s1', CHECKOUT))
  const checkRevision = (
    target: OrganizationTarget,
    expected: string,
    change: OrganizationChange
  ) =>
    checkOwnedRevision(target, expected, change, { stateFor: mirror.getState().stateFor, stores })
  const calls: string[] = []
  const rpc = vi.fn(async (method: string) => {
    calls.push(method)
    return {}
  }) as unknown as OrganizationRpc
  return { stores, mirror, deps: { stores, rpc, checkRevision, onApplied: vi.fn() }, calls }
}

const agentMove = (expectedRevision: string, value = SALES) => ({
  kind: 'move' as const,
  targets: [{ sessionKey: 's1' }],
  value,
  executor: PANE,
  reason: 'tidy',
  expectedRevision
})

describe('checkOwnedRevision', () => {
  it('refuses an agent change whose expected revision is stale, with nothing changed or recorded', async () => {
    const { stores, deps, calls } = setup()
    const outcome = await applyOrganizationChange(agentMove('older'), deps)
    expect(outcome).toMatchObject({
      status: 'refused',
      error: "This session's folder changed since revision older (it is at agent). Nothing changed."
    })
    expect(stores.folders.getState().metadata.membership.s1).toBe(CHECKOUT)
    expect(calls).toEqual([])
    await expect(applyOrganizationChange(agentMove('agent'), deps)).resolves.toMatchObject({
      status: 'applied',
      after: [SALES]
    })
  })

  it('refuses once the person moved it, and when it moved outside any recorded change', async () => {
    const moved = setup()
    moved.mirror.getState().applyRecord({
      ...agentFiled('s1', SALES),
      opId: 'mine',
      executor: { kind: 'person', via: 'sidebar' }
    })
    await expect(applyOrganizationChange(agentMove('agent'), moved.deps)).resolves.toMatchObject({
      status: 'refused',
      error: expect.stringContaining("is the person's now (person/sidebar)")
    })
    const drifted = setup()
    drifted.stores.folders.getState().moveSessions(['s1'], SALES)
    await expect(
      applyOrganizationChange(agentMove('agent', BATCH), drifted.deps)
    ).resolves.toMatchObject({
      status: 'refused',
      error: expect.stringContaining('was changed by something that recorded no change')
    })
  })

  it('never refuses the person, and leaves fields without ownership to main', () => {
    const { mirror, stores } = setup()
    const stateFor = mirror.getState().stateFor
    const person = {
      ...agentMove('older'),
      opId: 'undo',
      executor: { kind: 'person', via: 'notice' }
    } as OrganizationChange
    expect(
      checkOwnedRevision({ sessionKey: 's1' }, 'older', person, { stateFor, stores })
    ).toBeNull()
    const archive = {
      ...agentMove('older'),
      opId: 'a',
      kind: 'archive',
      value: true
    } as OrganizationChange
    expect(
      checkOwnedRevision({ sessionKey: 's1' }, 'older', archive, { stateFor, stores })
    ).toBeNull()
    const unowned = { ...agentMove('agent'), opId: 'b', targets: [{ sessionKey: 's2' }] }
    expect(
      checkOwnedRevision({ sessionKey: 's2' }, 'agent', unowned as OrganizationChange, {
        stateFor,
        stores
      })
    ).toContain('counts as the person')
  })
})

describe('seeding 1a batch filings', () => {
  const origins: SessionBatchOrigins = {
    version: 1,
    folders: {
      [BATCH]: {
        folderId: BATCH,
        batchId: 'b1',
        requestExcerpt: 'fix PDF export, Refer & Earn copy',
        createdAt: 1_790_000_000_000,
        source: 'session-prep'
      }
    },
    sessions: {
      stayed: { batchId: 'b1', index: 0, at: 1_790_000_000_000 },
      moved: { batchId: 'b1', index: 1, at: 1_790_000_000_000 },
      unfiled: { batchId: 'b1', index: 2, at: 1_790_000_000_000 }
    }
  }
  const metadata: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: BATCH, name: 'Launch' },
      { id: SALES, name: 'Sales' }
    ],
    membership: { stayed: BATCH, moved: SALES }
  }

  it('seeds only the sessions still in their batch folder', () => {
    expect(batchLaunchSeeds(origins, metadata)).toEqual([
      { key: 'stayed', value: BATCH, batchId: 'b1', at: new Date(1_790_000_000_000).toISOString() }
    ])
  })

  beforeEach(() => {
    useSessionOrganizationOwnership.setState({ keys: {}, scope: null })
  })

  afterEach(() => {
    useSessionOrganizationOwnership.setState({ keys: {}, scope: null })
  })

  it('reads main’s copy, then asks main to seed what it knows nothing of', async () => {
    useSessionFolders.setState({ metadata, loaded: true })
    useSessionBatchOrigins.setState({ data: origins, scope: 'omni.session-batch-origins.v1' })
    const seeded = {
      stayed: {
        ownership: {
          placement: { value: BATCH, revision: 'seed:b1', by: 'launch', opId: 'seed:b1', at: 'x' }
        },
        revocations: {}
      }
    }
    const params: Record<string, unknown> = {}
    const rpc = vi.fn(async (method: string, body: unknown) => {
      params[method] = body
      return method === SESSION_ORGANIZATION_OWNERSHIP_RPC.seed ? { keys: seeded } : { keys: {} }
    }) as unknown as OrganizationRpc
    await refreshSessionOrganizationOwnership(rpc)
    expect(params[SESSION_ORGANIZATION_OWNERSHIP_RPC.seed]).toEqual({
      seeds: [expect.objectContaining({ key: 'stayed', batchId: 'b1' })]
    })
    expect(
      useSessionOrganizationOwnership.getState().ownedField('stayed', 'placement')
    ).toMatchObject({ revision: 'seed:b1' })
    expect(useSessionOrganizationOwnership.getState().ownedField('moved', 'placement')).toBeNull()
  })
})
