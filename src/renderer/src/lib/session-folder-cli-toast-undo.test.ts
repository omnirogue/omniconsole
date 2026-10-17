import { describe, expect, it, vi } from 'vitest'
import type { OrganizationUndoPlan } from '../../../shared/session-organization-change'
import { undoRelayedFolderChange } from './session-folder-cli-toast-undo'
import {
  CHECKOUT,
  createOrganizationTestStores,
  fakeOrganizationRpc,
  SALES
} from './session-organization-test-fixture'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

describe('Undo on a CLI change’s toast', () => {
  it('undoes a recorded move through main’s record, as the person', async () => {
    const stores = createOrganizationTestStores({ membership: { a: CHECKOUT } })
    const plan: OrganizationUndoPlan = {
      opId: 'cli-1',
      inverse: { kind: 'move', targets: [{ sessionKey: 'a' }], value: SALES, undoOf: 'cli-1' },
      targets: [{ target: { sessionKey: 'a' }, status: 'undo', expected: CHECKOUT }],
      partial: false
    }
    const { rpc, calls } = fakeOrganizationRpc({ 'sessionOrganization.undoPlan': plan })
    const metadata = stores.folders.getState().metadata
    const undone = await undoRelayedFolderChange(
      { before: metadata, after: metadata },
      { opId: 'cli-1', kind: 'move', targets: [{ sessionKey: 'a' }] },
      stores,
      { rpc }
    )
    expect(undone).toBe(true)
    expect(stores.folders.getState().metadata.membership.a).toBe(SALES)
    expect(calls.map((call) => call.method)).toEqual([
      'sessionOrganization.undoPlan',
      'sessionOrganization.settle'
    ])
    expect(calls[1]!.params.change).toMatchObject({
      kind: 'move',
      undoOf: 'cli-1',
      executor: { kind: 'person', via: 'notice' }
    })
  })

  it('reports nothing undone when the session changed since', async () => {
    const stores = createOrganizationTestStores()
    const { rpc } = fakeOrganizationRpc({
      'sessionOrganization.undoPlan': {
        opId: 'cli-1',
        inverse: null,
        targets: [{ target: { sessionKey: 'a' }, status: 'changed-since' }],
        partial: false
      } satisfies OrganizationUndoPlan
    })
    const metadata = stores.folders.getState().metadata
    const undone = await undoRelayedFolderChange(
      { before: metadata, after: metadata },
      { opId: 'cli-1', kind: 'move', targets: [{ sessionKey: 'a' }] },
      stores,
      { rpc }
    )
    expect(undone).toBe(false)
    expect(stores.folders.getState().metadata.membership.a).toBe(SALES)
  })

  it('puts a created folder back by the tree snapshot and records it as the person’s Undo', async () => {
    const stores = createOrganizationTestStores()
    const before = stores.folders.getState().metadata
    const id = stores.folders.getState().createFolder('Planning')!
    const after = stores.folders.getState().metadata
    const { rpc, calls } = fakeOrganizationRpc()
    const undone = await undoRelayedFolderChange(
      { before, after },
      { opId: 'cli-2', kind: 'folder.create', targets: [{ folderId: id }] },
      stores,
      { rpc }
    )
    expect(undone).toBe(true)
    expect(stores.folders.getState().metadata.folders.some((folder) => folder.id === id)).toBe(
      false
    )
    expect(calls.map((call) => call.method)).toEqual(['sessionOrganization.settle'])
    expect(calls[0]!.params.change).toMatchObject({
      kind: 'folder.delete',
      targets: [{ folderId: id }],
      undoOf: 'cli-2',
      executor: { kind: 'person', via: 'notice' }
    })
  })

  it('falls back to the tree snapshot when main has no record to plan from', async () => {
    const stores = createOrganizationTestStores()
    const before = stores.folders.getState().metadata
    stores.folders.getState().moveSessions(['a'], CHECKOUT)
    const after = stores.folders.getState().metadata
    const { rpc } = fakeOrganizationRpc({
      'sessionOrganization.undoPlan': () => {
        throw new Error('Unknown method')
      }
    })
    const undone = await undoRelayedFolderChange(
      { before, after },
      { opId: 'cli-3', kind: 'move', targets: [{ sessionKey: 'a' }] },
      stores,
      { rpc }
    )
    expect(undone).toBe(true)
    expect(stores.folders.getState().metadata.membership.a).toBe(SALES)
  })
})
