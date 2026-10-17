import { describe, expect, it } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import {
  emptySessionFolderMetadata,
  parseSessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolderMetadata
} from './session-folders'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'

const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'w1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Quarterly report',
  workspaceLabel: 'Reports',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
function fixture() {
  let persisted: SessionFolderMetadata = emptySessionFolderMetadata()
  const storage = {
    load: () => parseSessionFolderMetadata(JSON.parse(JSON.stringify(persisted))),
    save: (value: SessionFolderMetadata) => {
      persisted = structuredClone(value)
    }
  }
  const store = createSessionFoldersStore(storage)
  store.getState().load()
  return { store, storage }
}
function tree(metadata: SessionFolderMetadata, collapsed: string[] = ['saved-sessions:open']) {
  return buildSessionSidebarTree({
    metadata,
    sessions: [session],
    now: Date.now(),
    view: { ...emptySessionSidebarView(), collapsed },
    query: '',
    showHidden: false,
    snapshot: { cardsByPaneKey: new Map(), cardsByTabId: new Map(), attentionByPaneKey: new Map() }
  })
}
describe('Saved Sessions reuses persistent folder membership', () => {
  it('keeps the saved root and child folder after a reload, outside Active and retention', () => {
    const { store, storage } = fixture()
    const folderId = store.getState().createFolder('Client reports', 'saved')!
    expect(store.getState().saveSession('session', folderId)).toBe(true)
    const reloaded = createSessionFoldersStore(storage)
    reloaded.getState().load()
    const groups = tree(reloaded.getState().metadata).groups
    expect(groups.map((group) => group.label)).toEqual(['Saved Sessions', 'Client reports'])
    expect(groups[0]?.childRowCount).toBe(1)
    expect(groups[1]?.rows[0]?.session).toEqual(session)
    expect(groups[1]?.rows[0]?.archived).toBe(false)
  })
  it('renames a saved folder and deletes only its container, keeping sessions saved at the root', () => {
    const { store } = fixture()
    const folderId = store.getState().createFolder('Old', 'saved')!
    store.getState().saveSession('session', folderId)
    expect(store.getState().renameFolder(folderId, 'Finished reports')).toBe(true)
    expect(store.getState().deleteFolder(folderId)).toBe(true)
    expect(store.getState().metadata.membership.session).toBe(SAVED_SESSIONS_FOLDER_ID)
    expect(tree(store.getState().metadata).groups[0]?.rows[0]?.session.sessionKey).toBe('session')
  })
  it('collapses the saved root and all its subfolders together', () => {
    const { store } = fixture()
    const folderId = store.getState().createFolder('Reports', 'saved')!
    store.getState().saveSession('session', folderId)
    const groups = tree(store.getState().metadata, [SAVED_SESSIONS_FOLDER_ID]).groups
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'saved', collapsed: true, childRowCount: 1 })
  })
  it('migrates an armed finish choice even before the session is in a folder', () => {
    const { store } = fixture()
    const action = {
      action: 'save' as const,
      folderId: SAVED_SESSIONS_FOLDER_ID,
      chainId: 'chain',
      revision: 2
    }
    store.getState().setFinishAction('temporary', action)
    expect(store.getState().migrateSessionKey('temporary', 'session')).toBe(true)
    expect(store.getState().metadata.finishActions).toEqual({ session: action })
  })
  it('does not remove a session from Active when saving metadata fails', () => {
    const store = createSessionFoldersStore({
      load: emptySessionFolderMetadata,
      save: () => {
        throw new Error('disk full')
      }
    })
    store.getState().load()
    expect(store.getState().saveSession('session', SAVED_SESSIONS_FOLDER_ID)).toBe(false)
    expect(store.getState().metadata.membership).toEqual({})
    expect(store.getState().error).toContain('Could not save')
  })
  it('marks a pending finish applied in the same write that saves its session', () => {
    const { store, storage } = fixture()
    store.getState().setFinishAction('session', {
      action: 'save',
      folderId: SAVED_SESSIONS_FOLDER_ID,
      chainId: 'chain',
      revision: 1
    })
    store.getState().saveSession('session', SAVED_SESSIONS_FOLDER_ID)
    expect(storage.load()).toMatchObject({
      membership: { session: SAVED_SESSIONS_FOLDER_ID },
      finishActions: { session: { applied: true } }
    })
  })
})
