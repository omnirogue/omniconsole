import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import {
  applySessionFolderOp,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from './session-folder-cli-apply'
import { undoSessionFolderChange } from './session-folder-cli-undo'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolderMetadata } from './session-folders'
import { SESSION_OTHER_GROUP_KEY } from './session-sidebar-tree'
import {
  emptySessionSidebarView,
  orderSessionGroupKeys,
  sessionFolderGroupKey
} from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const Q3 = '00000000-0000-4000-8000-000000000002'
const MARKETING = '00000000-0000-4000-8000-000000000003'
const CLIENTS = '00000000-0000-4000-8000-000000000004'
const ACME = '00000000-0000-4000-8000-000000000005'
const BETA = '00000000-0000-4000-8000-000000000006'
const ARCHIVE = '00000000-0000-4000-8000-000000000007'

function createStores(): SessionFolderCliStores {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: Q3, name: 'Q3', parentId: SALES },
      { id: MARKETING, name: 'Marketing' },
      { id: CLIENTS, name: 'Clients', section: 'saved' },
      { id: ACME, name: 'Acme', section: 'saved', parentId: CLIENTS },
      { id: BETA, name: 'Beta', section: 'saved', parentId: CLIENTS },
      { id: ARCHIVE, name: 'Archive', section: 'saved' }
    ],
    membership: { 's-sales': SALES, 's-q3': Q3, 's-clients': CLIENTS, 's-acme': ACME }
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

function refused(
  stores: SessionFolderCliStores,
  op: SessionFolderOp,
  session: SessionFolderCliSession | null = null
): string {
  const result = applySessionFolderOp(op, stores, session)
  return result.ok ? 'applied' : result.error
}

const ids = (stores: SessionFolderCliStores): string[] =>
  stores.folders.getState().metadata.folders.map((folder) => folder.id)

describe('deleteFolder', () => {
  it('moves a top-level saved folder’s sessions into Saved Sessions and lifts its subfolders, with undo', () => {
    const stores = createStores()
    const before = stores.folders.getState().metadata
    const result = applied(stores, { kind: 'deleteFolder', folder: 'Saved Sessions / Clients' })
    const { metadata } = stores.folders.getState()
    expect(ids(stores)).not.toContain(CLIENTS)
    expect(metadata.folders.find((folder) => folder.id === ACME)).toEqual({
      id: ACME,
      name: 'Acme',
      section: 'saved'
    })
    // Why: a top-level saved folder hands its sessions to Saved Sessions, so nothing is unsaved.
    expect(metadata.membership['s-clients']).toBe(SAVED_SESSIONS_FOLDER_ID)
    expect(metadata.membership['s-acme']).toBe(ACME)
    expect(result.result.folder).toMatchObject({ id: CLIENTS, path: 'Saved Sessions / Clients' })
    expect(result.result.summary).toContain('Saved Sessions')
    expect(undoSessionFolderChange(result.undo, stores)).toBe(true)
    expect(stores.folders.getState().metadata).toEqual(before)
  })

  it('hands a nested folder’s sessions to its parent', () => {
    const stores = createStores()
    const result = applied(stores, { kind: 'deleteFolder', folder: 'Sales / Q3' })
    expect(stores.folders.getState().metadata.membership['s-q3']).toBe(SALES)
    expect(result.result.summary).toContain('“Sales”')
    expect(result.reveal).toEqual([sessionFolderGroupKey(SALES)])
  })

  it('unfiles a top-level Conversations folder’s sessions and lifts its subfolders', () => {
    const stores = createStores()
    applied(stores, { kind: 'deleteFolder', folder: 'Sales' })
    const { metadata } = stores.folders.getState()
    expect(Object.hasOwn(metadata.membership, 's-sales')).toBe(false)
    expect(metadata.membership['s-q3']).toBe(Q3)
    expect(metadata.folders.find((folder) => folder.id === Q3)?.parentId).toBeUndefined()
  })

  it('refuses Saved Sessions itself', () => {
    expect(refused(createStores(), { kind: 'deleteFolder', folder: 'Saved Sessions' })).toContain(
      'cannot be moved, renamed or deleted'
    )
  })
})

describe('reorderFolder', () => {
  it('orders a top-level Conversations folder through the sidebar group order, with undo', () => {
    const stores = createStores()
    const result = applied(stores, {
      kind: 'reorderFolder',
      folder: 'Marketing',
      target: 'Sales',
      position: 'before'
    })
    const order = stores.view.getState().view.order
    expect(order.slice(0, 3)).toEqual([
      sessionFolderGroupKey(MARKETING),
      sessionFolderGroupKey(SALES),
      SESSION_OTHER_GROUP_KEY
    ])
    // Why: the stored folders keep their order; only the per-device view moved, as a drag does.
    expect(ids(stores).indexOf(SALES)).toBeLessThan(ids(stores).indexOf(MARKETING))
    expect(result.result.summary).toBe('Moved folder “Marketing” before “Sales”')
    expect(undoSessionFolderChange(result.undo, stores)).toBe(true)
    const keys = [sessionFolderGroupKey(SALES), sessionFolderGroupKey(MARKETING)]
    expect(orderSessionGroupKeys(keys, stores.view.getState().view.order)).toEqual(keys)
  })

  it('orders subfolders and Saved Sessions folders in the stored folder list', () => {
    const stores = createStores()
    const result = applied(stores, {
      kind: 'reorderFolder',
      folder: 'Clients / Beta',
      target: 'Acme',
      position: 'before'
    })
    expect(ids(stores).indexOf(BETA)).toBeLessThan(ids(stores).indexOf(ACME))
    expect(stores.view.getState().view.order).toEqual([])
    applied(stores, {
      kind: 'reorderFolder',
      folder: 'Saved Sessions / Clients',
      target: 'Saved Sessions / Archive',
      position: 'after'
    })
    expect(ids(stores).indexOf(CLIENTS)).toBeGreaterThan(ids(stores).indexOf(ARCHIVE))
    // Why: a reorder has no field to put back once other changes followed it.
    expect(undoSessionFolderChange(result.undo, stores)).toBe(false)
    expect(ids(stores).indexOf(BETA)).toBeLessThan(ids(stores).indexOf(ACME))
  })

  it('refuses folders in different places, itself, and Saved Sessions as a target', () => {
    const stores = createStores()
    const op = (folder: string, target: string): SessionFolderOp => ({
      kind: 'reorderFolder',
      folder,
      target,
      position: 'after'
    })
    expect(refused(stores, op('Sales / Q3', 'Marketing'))).toContain('not in the same folder')
    expect(refused(stores, op('Sales', 'Saved Sessions / Archive'))).toContain(
      'not in the same folder'
    )
    expect(refused(stores, op('Sales', 'Sales'))).toContain('itself')
    expect(refused(stores, op('Sales', 'Saved Sessions'))).toContain('is a section')
  })
})

describe('session archive and delete', () => {
  const session = { key: 'conversation:one', label: 'Payouts', tabId: 'tab-1' }

  it('archives by hand, refuses a repeat, unarchives, and undo takes it back', () => {
    const stores = createStores()
    const archived = applied(
      stores,
      { kind: 'archiveSession', paneKey: 'p', archived: true },
      session
    )
    expect(stores.view.getState().archived).toEqual([session.key])
    expect(archived.result).toEqual({ summary: 'Archived “Payouts”', sessionKey: session.key })
    expect(
      refused(stores, { kind: 'archiveSession', paneKey: 'p', archived: true }, session)
    ).toContain('already archived')
    expect(undoSessionFolderChange(archived.undo, stores)).toBe(true)
    expect(stores.view.getState().archived).toEqual([])
    expect(
      refused(stores, { kind: 'archiveSession', paneKey: 'p', archived: false }, session)
    ).toContain('nothing to unarchive')
  })

  it('deletes the row from the list, and undo brings it back', () => {
    const stores = createStores()
    const deleted = applied(stores, { kind: 'deleteSession', tabId: 'tab-1' }, session)
    expect(stores.view.getState().view.deleted).toEqual([session.key])
    expect(deleted.result.summary).toBe('Deleted “Payouts”')
    expect(undoSessionFolderChange(deleted.undo, stores)).toBe(true)
    expect(stores.view.getState().view.deleted).toEqual([])
  })

  it('refuses a conversation that is not in the sidebar', () => {
    expect(refused(createStores(), { kind: 'deleteSession', paneKey: 'p' })).toContain(
      'not in the sidebar'
    )
  })
})
