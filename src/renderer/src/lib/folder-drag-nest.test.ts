import { describe, expect, it } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import {
  emptySessionFolderMetadata,
  isSessionSaved,
  parseSessionFolderMetadata,
  type SessionFolderMetadata
} from './session-folders'
import { sessionFolderSubtreeIds } from './session-folder-tree'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import {
  resolveFolderHeaderZone,
  resolveSessionGroupDrop,
  type SessionSidebarDragInFlight
} from './session-sidebar-drag'
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
  label: 'Affiliate payouts',
  workspaceLabel: 'Reports',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

function fixture() {
  let persisted: SessionFolderMetadata = emptySessionFolderMetadata()
  const store = createSessionFoldersStore({
    load: () => parseSessionFolderMetadata(JSON.parse(JSON.stringify(persisted))),
    save: (value: SessionFolderMetadata) => {
      persisted = structuredClone(value)
    }
  })
  store.getState().load()
  return store
}

function tree(metadata: SessionFolderMetadata, open: string[]) {
  return buildSessionSidebarTree({
    metadata,
    sessions: [session],
    now: Date.now(),
    view: {
      ...emptySessionSidebarView(),
      collapsed: [...open.map((id) => `${sessionFolderGroupKey(id)}:open`), 'saved-sessions:open']
    },
    query: '',
    showHidden: false,
    snapshot: { cardsByPaneKey: new Map(), cardsByTabId: new Map(), attentionByPaneKey: new Map() }
  })
}

describe('dragging folders into folders', () => {
  it('moves a saved folder with its subfolder and sessions into a Conversations folder', () => {
    const store = fixture()
    const affiliates = store.getState().createFolder('Affiliates')!
    const payouts = store.getState().createFolder('Payouts', 'saved')!
    const june = store.getState().createFolder('June', 'saved', payouts)!
    expect(store.getState().saveSession('session', june)).toBe(true)
    expect(isSessionSaved(store.getState().metadata, 'session')).toBe(true)

    expect(store.getState().moveFolder(payouts, affiliates)).toBe(true)
    const { metadata } = store.getState()
    const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
    expect(byId.get(payouts)).toMatchObject({ parentId: affiliates })
    expect(byId.get(payouts)?.section).toBeUndefined()
    expect(byId.get(june)).toMatchObject({ parentId: payouts })
    expect(byId.get(june)?.section).toBeUndefined()
    // Why: the session goes with its folder, so it now sits in the open list, not Saved.
    expect(metadata.membership.session).toBe(june)
    expect(isSessionSaved(metadata, 'session')).toBe(false)

    const folderGroups = tree(metadata, [affiliates, payouts, june]).groups.filter(
      (group) => group.folder
    )
    expect(folderGroups.map((group) => [group.label, group.depth, group.canReorder])).toEqual([
      ['Affiliates', 0, true],
      ['Payouts', 1, false],
      ['June', 2, false]
    ])
    expect(folderGroups.map((group) => group.childRowCount)).toEqual([1, 1, 0])
  })

  it('folds nested Conversations folders under a folded parent', () => {
    const store = fixture()
    const affiliates = store.getState().createFolder('Affiliates')!
    const payouts = store.getState().createFolder('Payouts')!
    expect(store.getState().moveFolder(payouts, affiliates)).toBe(true)
    const folded = tree(store.getState().metadata, [payouts]).groups.filter((group) => group.folder)
    expect(folded.map((group) => group.label)).toEqual(['Affiliates'])
  })

  it('moves a Conversations folder to the top of Saved Sessions, saving its sessions', () => {
    const store = fixture()
    const affiliates = store.getState().createFolder('Affiliates')!
    store.getState().moveSession('session', affiliates)
    expect(store.getState().moveFolder(affiliates, null, 'saved')).toBe(true)
    expect(isSessionSaved(store.getState().metadata, 'session')).toBe(true)
  })
})

describe('resolveSessionGroupDrop for folders', () => {
  const rect = { top: 0, height: 20 }
  const savedDrag = (subtreeIds: string[] = ['s1']): SessionSidebarDragInFlight => ({
    kind: 'group',
    groupKey: sessionFolderGroupKey('s1'),
    canReorder: false,
    folder: { id: 's1', parentId: null, section: 'saved', subtreeIds }
  })
  const affiliates = {
    key: sessionFolderGroupKey('a1'),
    kind: 'folder' as const,
    folderId: 'a1',
    canReorder: true,
    section: 'active' as const
  }

  it('puts a saved folder inside a Conversations folder anywhere on its heading', () => {
    for (const clientY of [1, 10, 19]) {
      expect(
        resolveSessionGroupDrop({ drag: savedDrag(), group: affiliates, clientY, rect })
      ).toEqual({ kind: 'folder', parentId: 'a1', section: 'active' })
    }
  })

  it('reorders top-level folders at the heading edges and nests in the middle', () => {
    const drag: SessionSidebarDragInFlight = {
      kind: 'group',
      groupKey: sessionFolderGroupKey('b1'),
      canReorder: true,
      folder: { id: 'b1', parentId: null, section: 'active', subtreeIds: ['b1'] }
    }
    expect(resolveFolderHeaderZone(2, rect)).toBe('before')
    expect(resolveSessionGroupDrop({ drag, group: affiliates, clientY: 2, rect })).toEqual({
      kind: 'group',
      position: 'before'
    })
    expect(resolveSessionGroupDrop({ drag, group: affiliates, clientY: 10, rect })).toEqual({
      kind: 'folder',
      parentId: 'a1',
      section: 'active'
    })
    expect(resolveSessionGroupDrop({ drag, group: affiliates, clientY: 18, rect })).toEqual({
      kind: 'group',
      position: 'after'
    })
  })

  it('refuses a drop into the folder itself or its own subfolders', () => {
    const subtree = [...sessionFolderSubtreeIds([], 's1'), 'a1']
    expect(
      resolveSessionGroupDrop({ drag: savedDrag(subtree), group: affiliates, clientY: 10, rect })
    ).toBeNull()
  })

  it('takes a folder into a folder through its body, and lifts one out onto Saved Sessions', () => {
    expect(
      resolveSessionGroupDrop({
        drag: savedDrag(),
        group: affiliates,
        clientY: 0,
        rect,
        zone: 'body'
      })
    ).toEqual({ kind: 'folder', parentId: 'a1', section: 'active' })
    const nested: SessionSidebarDragInFlight = {
      kind: 'group',
      groupKey: sessionFolderGroupKey('s2'),
      canReorder: false,
      folder: { id: 's2', parentId: 's1', section: 'saved', subtreeIds: ['s2'] }
    }
    expect(
      resolveSessionGroupDrop({
        drag: nested,
        group: { key: 'saved-sessions', kind: 'saved', folderId: null, canReorder: false },
        clientY: 10,
        rect
      })
    ).toEqual({ kind: 'folder', parentId: null, section: 'saved' })
  })
})
