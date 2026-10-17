import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import {
  applySessionFolderOp,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from './session-folder-cli-apply'
import { listSessionFolderEntries } from './session-folder-cli-list'
import { undoSessionFolderChange } from './session-folder-cli-undo'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView, sessionFolderGroupKey } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const CLIENTS = '00000000-0000-4000-8000-000000000002'

function createStores(): SessionFolderCliStores {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CLIENTS, name: 'Clients', section: 'saved' }
    ],
    membership: { 'pane-a': SALES }
  }
  const folders = createSessionFoldersStore({ save: vi.fn(), load: vi.fn(() => initial) })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  return { folders, view }
}

function applied(
  stores: SessionFolderCliStores,
  op: SessionFolderOp,
  session: SessionFolderCliSession | null = null
) {
  const result = applySessionFolderOp(op, stores, session)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('applySessionFolderOp', () => {
  it('loads the stores on first use and lists folders with saved paths', () => {
    const stores = createStores()
    applied(stores, { kind: 'colorFolder', folder: 'Sales', color: 'green' })
    expect(
      listSessionFolderEntries(stores.folders.getState().metadata, stores.view.getState().view)
    ).toEqual([
      {
        id: SALES,
        name: 'Sales',
        path: 'Sales',
        section: 'active',
        parentId: null,
        color: 'green',
        sessionCount: 1
      },
      {
        id: CLIENTS,
        name: 'Clients',
        path: 'Saved Sessions / Clients',
        section: 'saved',
        parentId: null,
        color: null,
        sessionCount: 0
      }
    ])
  })

  it('creates a folder inside Saved Sessions and reveals it', () => {
    const stores = createStores()
    const result = applied(stores, { kind: 'createFolder', name: 'X', parent: 'Saved Sessions' })
    const created = result.result.folder!
    expect(created).toMatchObject({ name: 'X', path: 'Saved Sessions / X', section: 'saved' })
    expect(result.reveal).toEqual([SAVED_SESSIONS_FOLDER_ID, sessionFolderGroupKey(created.id)])
    expect(result.result.summary).toContain('Saved Sessions / X')
  })

  it('takes the parent section over --saved', () => {
    const stores = createStores()
    const result = applied(stores, {
      kind: 'createFolder',
      name: 'Q3',
      parent: 'Sales',
      saved: true
    })
    expect(result.result.folder).toMatchObject({
      path: 'Sales / Q3',
      section: 'active',
      parentId: SALES
    })
  })

  it('moves a folder with its sessions into a saved folder, and undo puts it back', () => {
    const stores = createStores()
    // Why: the apply loads a store on first use; load first so `before` is the loaded snapshot.
    stores.folders.getState().load()
    const before = stores.folders.getState().metadata
    const result = applied(stores, {
      kind: 'moveFolder',
      folder: 'sales',
      into: 'Saved Sessions/Clients'
    })
    expect(result.result.folder).toMatchObject({
      path: 'Saved Sessions / Clients / Sales',
      section: 'saved'
    })
    expect(result.reveal).toEqual([SAVED_SESSIONS_FOLDER_ID, sessionFolderGroupKey(CLIENTS)])
    expect(result.undo.before).toBe(before)
    expect(undoSessionFolderChange(result.undo, stores)).toBe(true)
    expect(stores.folders.getState().metadata.folders).toEqual(before.folders)
  })

  it('moves a folder to the top of the other section', () => {
    const stores = createStores()
    const result = applied(stores, { kind: 'moveFolder', folder: 'Sales', section: 'saved' })
    expect(result.result.folder).toMatchObject({ path: 'Saved Sessions / Sales', parentId: null })
  })

  it('files a session and unfiles it', () => {
    const stores = createStores()
    const session = { key: 'pane-b', label: 'Claude' }
    const filed = applied(
      stores,
      { kind: 'moveSession', paneKey: 'p', destination: 'folder', folder: 'Clients' },
      session
    )
    expect(stores.folders.getState().metadata.membership['pane-b']).toBe(CLIENTS)
    expect(filed.result.sessionKey).toBe('pane-b')
    const saved = applied(
      stores,
      { kind: 'moveSession', paneKey: 'p', destination: 'saved' },
      session
    )
    expect(stores.folders.getState().metadata.membership['pane-b']).toBe(SAVED_SESSIONS_FOLDER_ID)
    expect(saved.reveal).toEqual([SAVED_SESSIONS_FOLDER_ID])
    applied(stores, { kind: 'moveSession', paneKey: 'p', destination: 'unfile' }, session)
    expect(Object.hasOwn(stores.folders.getState().metadata.membership, 'pane-b')).toBe(false)
  })

  it('renames, and reports the store error on a clash', () => {
    const stores = createStores()
    applied(stores, { kind: 'renameFolder', folder: 'Sales', name: 'Revenue' })
    expect(stores.folders.getState().metadata.folders[0]!.name).toBe('Revenue')
    const clash = applySessionFolderOp(
      { kind: 'renameFolder', folder: 'Revenue', name: 'clients' },
      stores
    )
    expect(clash).toEqual({ ok: false, error: 'A folder with that name already exists.' })
  })

  it('colors by alias, clears, and undoes only while the color is unchanged', () => {
    const stores = createStores()
    const key = sessionFolderGroupKey(SALES)
    const colored = applied(stores, { kind: 'colorFolder', folder: 'Sales', color: 'Yellow' })
    expect(stores.view.getState().view.colors?.[key]).toBe('amber')
    expect(undoSessionFolderChange(colored.undo, stores)).toBe(true)
    expect(stores.view.getState().view.colors?.[key]).toBeUndefined()
    const again = applied(stores, { kind: 'colorFolder', folder: 'Sales', color: 'blue' })
    stores.view.getState().setGroupColor(key, 'red')
    expect(undoSessionFolderChange(again.undo, stores)).toBe(false)
    expect(stores.view.getState().view.colors?.[key]).toBe('red')
  })

  it('refuses an unknown color with the valid names', () => {
    const stores = createStores()
    const result = applySessionFolderOp(
      { kind: 'colorFolder', folder: 'Sales', color: 'plaid' },
      stores
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('red, orange, amber')
  })

  it('refuses a missing folder and moving Saved Sessions itself', () => {
    const stores = createStores()
    expect(
      applySessionFolderOp({ kind: 'moveFolder', folder: 'Nope', section: 'active' }, stores).ok
    ).toBe(false)
    const root = applySessionFolderOp(
      { kind: 'renameFolder', folder: 'Saved Sessions', name: 'Y' },
      stores
    )
    expect(!root.ok && root.error).toContain('Saved Sessions itself')
  })
})
