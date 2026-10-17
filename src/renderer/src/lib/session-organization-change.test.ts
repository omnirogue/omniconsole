import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { OrganizationUndoPlan } from '../../../shared/session-organization-change'
import {
  applyOrganizationChange,
  applyPersonOrganizationChange,
  setOrganizationRevisionCheck,
  undoOrganizationChange,
  type OrganizationRpc
} from './session-organization-change'
import type { OrganizationStores } from './session-organization-values'
import type { SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const CHECKOUT = '00000000-0000-4000-8000-000000000002'

function createStores(): OrganizationStores {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CHECKOUT, name: 'Checkout' }
    ],
    membership: { a: SALES }
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

/** Records every call; `answers` by method, a function to throw. */
function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (typeof answer === 'function') {
      return (answer as () => unknown)()
    }
    return answer ?? {}
  }) as unknown as OrganizationRpc
  return { rpc, calls }
}

const folderOf = (stores: OrganizationStores, key: string) =>
  stores.folders.getState().metadata.membership[key] ?? null

afterEach(() => {
  setOrganizationRevisionCheck(null)
})

describe('applyOrganizationChange', () => {
  it('applies a person’s change before recording it, as one record for every target', async () => {
    const stores = createStores()
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.settle': { revision: 'drag-1' } })
    const { outcome, recorded } = applyPersonOrganizationChange(
      {
        opId: 'drag-1',
        kind: 'move',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
        value: CHECKOUT,
        executor: { kind: 'person', via: 'sidebar' }
      },
      { stores, rpc }
    )
    // Already moved: the drop waited on no IPC.
    expect(folderOf(stores, 'a')).toBe(CHECKOUT)
    expect(outcome).toEqual({
      status: 'applied',
      opId: 'drag-1',
      before: [SALES, null],
      after: [CHECKOUT, CHECKOUT]
    })
    await expect(recorded).resolves.toEqual({ revision: 'drag-1' })
    expect(calls).toEqual([
      {
        method: 'sessionOrganization.settle',
        params: {
          phase: 'applied',
          change: expect.objectContaining({
            opId: 'drag-1',
            executor: { kind: 'person', via: 'sidebar' },
            targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }]
          }),
          before: [SALES, null],
          after: [CHECKOUT, CHECKOUT]
        }
      }
    ])
  })

  it('keeps a person’s change when recording fails, and says so', async () => {
    const stores = createStores()
    const { rpc } = fakeRpc({
      'sessionOrganization.settle': () => {
        throw new Error('runtime unavailable')
      }
    })
    const onRecordFailure = vi.fn()
    const outcome = await applyOrganizationChange(
      {
        kind: 'archive',
        targets: [{ sessionKey: 'a' }],
        value: true,
        executor: { kind: 'person', via: 'sidebar' }
      },
      { stores, rpc, onRecordFailure, mintOpId: () => 'op-x' }
    )
    expect(outcome).toMatchObject({
      status: 'applied',
      opId: 'op-x',
      recordError: 'runtime unavailable'
    })
    expect(stores.view.getState().archived).toEqual(['a'])
    expect(onRecordFailure).toHaveBeenCalledWith('runtime unavailable')
  })

  it('records an agent or app change as prepared first, and refuses it when that fails', async () => {
    const stores = createStores()
    const order: string[] = []
    const { rpc, calls } = fakeRpc({
      'sessionOrganization.prepare': () => {
        order.push(`prepare:${folderOf(stores, 'a')}`)
        return { opId: 'launch-1' }
      },
      'sessionOrganization.settle': () => {
        order.push(`settle:${folderOf(stores, 'a')}`)
        return { revision: 'launch-1' }
      }
    })
    const change = {
      opId: 'launch-1',
      kind: 'move' as const,
      targets: [{ sessionKey: 'a' }],
      value: CHECKOUT,
      executor: { kind: 'launch' as const, source: 'session-prep' as const },
      reason: 'filed at launch'
    }
    await expect(applyOrganizationChange(change, { stores, rpc })).resolves.toMatchObject({
      status: 'applied',
      revision: 'launch-1'
    })
    expect(order).toEqual([`prepare:${SALES}`, `settle:${CHECKOUT}`])
    expect(calls[0]?.params).toEqual({ change, before: [SALES] })

    const refusing = fakeRpc({
      'sessionOrganization.prepare': () => {
        throw new Error('Nothing changed: the change could not be recorded first')
      }
    })
    const fresh = createStores()
    await expect(
      applyOrganizationChange({ ...change, opId: 'launch-2' }, { stores: fresh, rpc: refusing.rpc })
    ).resolves.toEqual({
      status: 'refused',
      opId: 'launch-2',
      error: 'Nothing changed: the change could not be recorded first'
    })
    expect(folderOf(fresh, 'a')).toBe(SALES)
    expect(refusing.calls.map((call) => call.method)).toEqual(['sessionOrganization.prepare'])
  })

  it('asks the installed revision check only when a change expects a revision', async () => {
    const stores = createStores()
    const { rpc, calls } = fakeRpc()
    const check = vi.fn(() => 'Changed since: moved by you at 10:12.')
    setOrganizationRevisionCheck(check)
    const change = {
      kind: 'move' as const,
      targets: [{ sessionKey: 'a' }],
      value: CHECKOUT,
      executor: { kind: 'person' as const, via: 'notice' as const }
    }
    await expect(
      applyOrganizationChange({ ...change, expectedRevision: 'op-old' }, { stores, rpc })
    ).resolves.toMatchObject({ status: 'refused', error: 'Changed since: moved by you at 10:12.' })
    expect(check).toHaveBeenCalledWith({ sessionKey: 'a' }, 'op-old', expect.any(Object))
    expect(folderOf(stores, 'a')).toBe(SALES)
    expect(calls).toEqual([])
    await expect(applyOrganizationChange(change, { stores, rpc })).resolves.toMatchObject({
      status: 'applied'
    })
  })
})

describe('kinds without a window applier yet', () => {
  it('refuse plainly and change nothing (a save applies only through its store action)', async () => {
    const stores = createStores()
    const { rpc, calls } = fakeRpc()
    for (const kind of ['save', 'finish-action'] as const) {
      await expect(
        applyOrganizationChange(
          {
            kind,
            targets: [{ sessionKey: 'a' }],
            value: true,
            executor: { kind: 'person', via: 'sidebar' }
          },
          { stores, rpc }
        )
      ).resolves.toMatchObject({ status: 'failed', error: `No change path applies a ${kind} yet.` })
    }
    expect(calls).toEqual([])
  })
})

describe('undoOrganizationChange', () => {
  it('puts back what nothing changed since and reports what it skipped', async () => {
    const stores = createStores()
    stores.folders.getState().moveSessions(['a', 'b', 'c'], CHECKOUT)
    // `c` moved again in this window by a path that records nothing yet.
    stores.folders.getState().moveSessions(['c'], SALES)
    const plan: OrganizationUndoPlan = {
      opId: 'drag-1',
      inverse: {
        kind: 'move',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'c' }],
        value: SALES,
        values: [SALES, null],
        undoOf: 'drag-1',
        expectedRevision: 'drag-1'
      },
      targets: [
        { target: { sessionKey: 'a' }, status: 'undo', expected: CHECKOUT },
        { target: { sessionKey: 'b' }, status: 'changed-since', laterOpId: 'later' },
        { target: { sessionKey: 'c' }, status: 'undo', expected: CHECKOUT }
      ],
      partial: true
    }
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.undoPlan': plan })
    const result = await undoOrganizationChange('drag-1', { stores, rpc, via: 'sidebar' })
    expect(result).toMatchObject({ undone: 1, total: 3 })
    expect(result.skipped.map((entry) => [entry.target.sessionKey, entry.status])).toEqual([
      ['b', 'changed-since'],
      ['c', 'changed-since']
    ])
    expect(folderOf(stores, 'a')).toBe(SALES)
    expect(folderOf(stores, 'c')).toBe(SALES)
    expect(calls.map((call) => call.method)).toEqual([
      'sessionOrganization.undoPlan',
      'sessionOrganization.settle'
    ])
    expect(calls[1]?.params).toMatchObject({
      change: {
        kind: 'move',
        targets: [{ sessionKey: 'a' }],
        value: SALES,
        values: [SALES],
        undoOf: 'drag-1',
        executor: { kind: 'person', via: 'sidebar' }
      }
    })
  })

  it('reports why when main has no plan (not reconciled, or unknown)', async () => {
    const { rpc } = fakeRpc({
      'sessionOrganization.undoPlan': () => {
        throw new Error(
          'Change crash-1 was interrupted and is not reconciled yet, so it cannot be undone.'
        )
      }
    })
    await expect(
      undoOrganizationChange('crash-1', { stores: createStores(), rpc })
    ).resolves.toEqual({
      undone: 0,
      total: 0,
      skipped: [],
      error: 'Change crash-1 was interrupted and is not reconciled yet, so it cannot be undone.'
    })
  })
})
