import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('owner session title mirroring', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps the owner name per leaf, follows a rename, and leaves the local rename alone', () => {
    const surface = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Golden Stub Agent',
      isActive: true,
      launchAgent: 'claude' as const,
      status: 'ready' as const,
      terminal: 'terminal-1'
    }
    const first = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([{ ...surface, sessionTitle: 'Studio name' }]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirrored = first.tabsByWorktree![WT]![0]!
    expect(mirrored).toMatchObject({
      title: 'Golden Stub Agent',
      customTitle: null,
      runtimeOwnerTitleByLeafId: { [LEAF_ID]: 'Studio name' }
    })

    const renamedHere = {
      ...first,
      tabsByWorktree: { [WT]: [{ ...mirrored, customTitle: 'Mine' }] }
    }
    const second = applyWebSessionTabsSnapshot(
      makeState(renamedHere),
      makeSnapshot([{ ...surface, sessionTitle: 'Renamed on Studio' }], { snapshotVersion: 2 }),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>
    expect(second.tabsByWorktree![WT]![0]).toMatchObject({
      id: mirrored.id,
      customTitle: 'Mine',
      runtimeOwnerTitleByLeafId: { [LEAF_ID]: 'Renamed on Studio' }
    })

    const legacy = applyWebSessionTabsSnapshot(
      makeState({ ...renamedHere, ...second }),
      makeSnapshot([surface], { snapshotVersion: 3 }),
      ENV,
      NOW + 2
    ) as Partial<WebSessionTabsSyncState>
    expect(legacy.tabsByWorktree![WT]![0]!.runtimeOwnerTitleByLeafId).toEqual({})
  })
})
