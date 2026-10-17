import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteSessionFolderEdit,
  noteSessionsArchived,
  pendingSessionOrganizationIntent,
  sessionOrganizationScope,
  settleSessionOrganizationIntent
} from '@/lib/account-sync/session-organization-intent'
import { emptySessionFolderMetadata, type SessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { migrateSessionOrganizationKeys } from './session-organization-key-migration'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(key)
}))

const F = '00000000-0000-4000-8000-00000000000f'
const G = '00000000-0000-4000-8000-00000000000a'
const PANE = JSON.stringify(['local', 'pane', 'wt', 'tab:1'])
const PROVIDER = JSON.stringify(['local', 'provider', 'repo::/app\0claude\0claude\0s1'])
const MOVE = [{ folderKeyMigration: { from: PANE, to: PROVIDER } } as unknown as SidebarSession]

function stores(membership: Record<string, string>, archived: string[] = []) {
  const save = vi.fn()
  const metadata: SessionFolderMetadata = {
    ...emptySessionFolderMetadata(),
    folders: [
      { id: F, name: 'F' },
      { id: G, name: 'G' }
    ],
    membership
  }
  const folders = createSessionFoldersStore({ save, load: () => metadata })
  folders.getState().load()
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: () => emptySessionSidebarView() },
    { save: vi.fn(), load: () => archived }
  )
  view.getState().load()
  return { folders, view, save }
}

const pending = () => pendingSessionOrganizationIntent(sessionOrganizationScope())

beforeEach(() => {
  settleSessionOrganizationIntent(sessionOrganizationScope(), pending())
})

describe('migrateSessionOrganizationKeys', () => {
  it('keeps the person’s filing of a pane over what its provider key held before', () => {
    const { folders, view } = stores({ [PROVIDER]: F, [PANE]: G })
    noteSessionFolderEdit(
      { ...folders.getState().metadata, membership: { [PROVIDER]: F } },
      folders.getState().metadata
    )
    migrateSessionOrganizationKeys(MOVE, { folders, view })
    expect(folders.getState().metadata.membership).toEqual({ [PROVIDER]: G })
    expect(pending().filed).toEqual(new Set([PROVIDER]))
  })

  it('keeps an unfiling, and leaves the provider key alone when the person did nothing', () => {
    const unfiled = stores({ [PROVIDER]: F })
    noteSessionFolderEdit(
      { ...unfiled.folders.getState().metadata, membership: { [PROVIDER]: F, [PANE]: G } },
      unfiled.folders.getState().metadata
    )
    migrateSessionOrganizationKeys(MOVE, unfiled)
    expect(unfiled.folders.getState().metadata.membership).toEqual({})
    settleSessionOrganizationIntent(sessionOrganizationScope(), pending())
    const untouched = stores({ [PROVIDER]: F, [PANE]: G })
    migrateSessionOrganizationKeys(MOVE, untouched)
    expect(untouched.folders.getState().metadata.membership).toEqual({ [PROVIDER]: F })
    expect(pending().filed.size).toBe(0)
  })

  it('keeps the pane’s filing and its pending change until the move is saved', () => {
    const { folders, view, save } = stores({ [PROVIDER]: F, [PANE]: G })
    noteSessionFolderEdit(
      { ...folders.getState().metadata, membership: { [PROVIDER]: F } },
      folders.getState().metadata
    )
    save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    migrateSessionOrganizationKeys(MOVE, { folders, view })
    // Nothing moved, so nothing was lost: the next update tries again with the same choice.
    expect(folders.getState().metadata.membership).toEqual({ [PROVIDER]: F, [PANE]: G })
    expect(pending().filed).toEqual(new Set([PANE]))
    migrateSessionOrganizationKeys(MOVE, { folders, view })
    expect(folders.getState().metadata.membership).toEqual({ [PROVIDER]: G })
    expect(pending().filed).toEqual(new Set([PROVIDER]))
  })

  it('hands ownership and history to the provider key with the folder it keeps, once the save lands', () => {
    const migrate = vi.fn()
    // The provider key held no folder: it takes the pane's, so the pane's placement travels.
    const unfiled = stores({ [PANE]: G })
    migrateSessionOrganizationKeys(MOVE, { ...unfiled, ownership: { migrate } })
    expect(migrate).toHaveBeenLastCalledWith([{ from: PANE, to: PROVIDER, placementFrom: true }])
    // The provider key kept its own folder: its placement (and its owner) stays.
    const filed = stores({ [PROVIDER]: F, [PANE]: G })
    migrateSessionOrganizationKeys(MOVE, { ...filed, ownership: { migrate } })
    expect(filed.folders.getState().metadata.membership).toEqual({ [PROVIDER]: F })
    expect(migrate).toHaveBeenLastCalledWith([{ from: PANE, to: PROVIDER, placementFrom: false }])
    // A filing noted on the pane wins, but only once its save lands.
    const claimed = stores({ [PROVIDER]: F, [PANE]: G })
    noteSessionFolderEdit(
      { ...claimed.folders.getState().metadata, membership: { [PROVIDER]: F } },
      claimed.folders.getState().metadata
    )
    claimed.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    migrateSessionOrganizationKeys(MOVE, { ...claimed, ownership: { migrate } })
    expect(migrate).toHaveBeenLastCalledWith([])
    migrateSessionOrganizationKeys(MOVE, { ...claimed, ownership: { migrate } })
    expect(migrate).toHaveBeenLastCalledWith([{ from: PANE, to: PROVIDER, placementFrom: true }])
  })

  it('keeps the person’s archiving or unarchiving of a pane', () => {
    const { folders, view } = stores({}, [PROVIDER])
    noteSessionsArchived([PANE])
    migrateSessionOrganizationKeys(MOVE, { folders, view })
    expect(view.getState().archived).toEqual([])
    expect(pending().archived).toEqual(new Set([PROVIDER]))
  })
})
