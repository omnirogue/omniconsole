import { describe, expect, it } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import {
  deleteSessionFolder,
  emptySessionFolderMetadata,
  parseSessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolderMetadata
} from './session-folders'
import { sessionFolderPath, sessionFolderTree } from './session-folder-tree'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView, sessionFolderGroupKey } from './session-sidebar-view'
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

// Why `saved-sessions:open`: Saved Sessions starts folded, so each view opens it explicitly.
function tree(metadata: SessionFolderMetadata, collapsed: string[] = []) {
  return buildSessionSidebarTree({
    metadata,
    sessions: [session],
    now: Date.now(),
    view: { ...emptySessionSidebarView(), collapsed: [...collapsed, 'saved-sessions:open'] },
    query: '',
    showHidden: false,
    snapshot: { cardsByPaneKey: new Map(), cardsByTabId: new Map(), attentionByPaneKey: new Map() }
  })
}

/** Clients / Acme / Q3, with the session saved in Q3. */
function threeLevels() {
  const { store, storage } = fixture()
  const clients = store.getState().createFolder('Clients', 'saved')!
  const acme = store.getState().createFolder('Acme', 'saved', clients)!
  const q3 = store.getState().createFolder('Q3', 'saved', acme)!
  expect(store.getState().saveSession('session', q3)).toBe(true)
  return { store, storage, clients, acme, q3 }
}

describe('nested Saved Sessions folders', () => {
  it('keeps folders three deep after a reload and draws them in tree order with depth', () => {
    const { storage, clients, acme, q3 } = threeLevels()
    const reloaded = createSessionFoldersStore(storage)
    reloaded.getState().load()
    // Why the :open marks: folders start folded, so each level is opened the way a click opens it.
    const groups = tree(
      reloaded.getState().metadata,
      [clients, acme, q3].map((id) => `${sessionFolderGroupKey(id)}:open`)
    ).groups
    const saved = groups.filter((group) => group.folder?.section === 'saved')
    expect(saved.map((group) => [group.label, group.depth])).toEqual([
      ['Clients', 0],
      ['Acme', 1],
      ['Q3', 2]
    ])
    expect(saved.map((group) => group.rows.length)).toEqual([0, 0, 1])
    // Why: a parent's heading counts what its subfolders hold.
    expect(saved.map((group) => group.childRowCount)).toEqual([1, 1, 0])
  })

  it('folds every subfolder under a collapsed folder', () => {
    const { store, acme, q3 } = threeLevels()
    // Why: Acme and Q3 are open, but Clients above them is folded (its default), so they hide.
    const groups = tree(
      store.getState().metadata,
      [acme, q3].map((id) => `${sessionFolderGroupKey(id)}:open`)
    ).groups
    expect(groups.filter((group) => group.folder).map((group) => group.label)).toEqual(['Clients'])
  })

  it('allows the same name under different parents but not twice among siblings', () => {
    const { store, clients, acme } = threeLevels()
    const other = store.getState().createFolder('Globex', 'saved', clients)!
    expect(store.getState().createFolder('Q3', 'saved', other)).not.toBeNull()
    expect(store.getState().createFolder('q3', 'saved', acme)).toBeNull()
  })

  it('moves a folder with its subfolders and refuses a move into its own branch', () => {
    const { store, clients, acme, q3 } = threeLevels()
    expect(store.getState().moveFolder(clients, q3)).toBe(false)
    expect(store.getState().moveFolder(acme, null)).toBe(true)
    const folders = store.getState().metadata.folders
    expect(sessionFolderTree(folders).map(({ folder, depth }) => [folder.name, depth])).toEqual([
      ['Clients', 0],
      ['Acme', 0],
      ['Q3', 1]
    ])
    expect(
      sessionFolderPath(
        folders,
        folders.find((folder) => folder.id === q3)!
      )
    ).toBe('Acme / Q3')
  })

  it('deleting a middle folder lifts its subfolders and sessions to its parent', () => {
    const { store, clients, acme, q3 } = threeLevels()
    store.getState().moveSession('session', acme)
    const next = deleteSessionFolder(store.getState().metadata, acme)
    expect(next.folders.find((folder) => folder.id === q3)?.parentId).toBe(clients)
    expect(next.membership.session).toBe(clients)
    const top = deleteSessionFolder(next, clients)
    expect(top.folders.find((folder) => folder.id === q3)?.parentId).toBeUndefined()
    expect(top.membership.session).toBe(SAVED_SESSIONS_FOLDER_ID)
  })

  it('puts a folder whose parent link loops or is missing back at the top', () => {
    const a = '00000000-0000-4000-8000-00000000000a'
    const b = '00000000-0000-4000-8000-00000000000b'
    const c = '00000000-0000-4000-8000-00000000000c'
    const parsed = parseSessionFolderMetadata({
      version: 1,
      folders: [
        { id: a, name: 'A', section: 'saved', parentId: b },
        { id: b, name: 'B', section: 'saved', parentId: a },
        { id: c, name: 'C', section: 'saved', parentId: '00000000-0000-4000-8000-0000000000ff' }
      ],
      membership: {}
    })
    expect(parsed.folders.every((folder) => folder.parentId === undefined)).toBe(true)
  })
})
