import { personalViewStorageKey } from './personal-view-storage'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLocalSessionFolderStorage,
  SESSION_FOLDERS_STORAGE_KEY
} from './session-folder-storage'
import { createSessionFoldersStore } from '@/store/session-folders'
import { getSessionFolderId } from './session-folders'
import { buildSidebarSessions } from './sidebar-sessions'
import { applySessionFolderKeyMigrations } from './session-folder-key-migration'
import {
  sessionTestSource,
  addSessionTestTab,
  addSessionTestRecord
} from './sidebar-session-test-fixtures'

const temporaryDirectories: string[] = []

function diskStorage() {
  const directory = mkdtempSync(join(tmpdir(), 'session-folders-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'local-storage.json')
  const adapter = createLocalSessionFolderStorage(() => ({
    getItem: (key) =>
      existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8'))[key] ?? null) : null,
    setItem: (key, value) => writeFileSync(file, JSON.stringify({ [key]: value }))
  }))
  return { adapter, file }
}

afterEach(() =>
  temporaryDirectories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

describe('local session folder persistence', () => {
  it('persists create, rename, move and Unfiled across a new store and restored session rows', () => {
    const { adapter, file } = diskStorage()
    const state = sessionTestSource()
    const tab = addSessionTestTab(state)
    addSessionTestRecord(state, tab)
    const key = buildSidebarSessions(state)[0].sessionKey!
    const first = createSessionFoldersStore(adapter)
    first.getState().load()
    const folder = first.getState().createFolder(' Client work ')!
    expect(first.getState().renameFolder(folder, 'Projects')).toBe(true)
    expect(first.getState().moveSession(key, folder)).toBe(true)
    const second = createSessionFoldersStore(adapter)
    second.getState().load()
    const restored = {
      ...state,
      tabsByWorktree: JSON.parse(JSON.stringify(state.tabsByWorktree)),
      terminalLayoutsByTabId: JSON.parse(JSON.stringify(state.terminalLayoutsByTabId)),
      sleepingAgentSessionsByPaneKey: JSON.parse(
        JSON.stringify(state.sleepingAgentSessionsByPaneKey)
      )
    }
    restored.tabsByWorktree[tab.worktreeId][0].ptyId = null
    restored.tabsByWorktree[tab.worktreeId][0].generation = 9
    expect(buildSidebarSessions(restored)[0].sessionKey).toBe(key)
    expect(second.getState().metadata.folders).toEqual([{ id: folder, name: 'Projects' }])
    expect(getSessionFolderId(second.getState().metadata, key)).toBe(folder)
    expect(second.getState().moveSession(key, null)).toBe(true)
    const third = createSessionFoldersStore(adapter)
    third.getState().load()
    expect(getSessionFolderId(third.getState().metadata, key)).toBeNull()
    const persisted = JSON.parse(
      JSON.parse(readFileSync(file, 'utf8'))[personalViewStorageKey(SESSION_FOLDERS_STORAGE_KEY)]
    )
    expect(Object.keys(persisted).sort()).toEqual(['folders', 'membership', 'version'])
    expect(persisted).not.toHaveProperty('sessions')
  })

  it('keeps a terminal-hosted conversation in its folder as its provider session arrives, then across a restart', () => {
    const { adapter } = diskStorage()
    const state = sessionTestSource()
    const tab = addSessionTestTab(state)
    const store = createSessionFoldersStore(adapter)
    store.getState().load()
    const folder = store.getState().createFolder('Client work')!
    // Why: the person files the conversation while it is still a bare terminal
    // pane, before Claude has reported a provider session.
    const provisionalRows = buildSidebarSessions(state)
    const provisionalKey = provisionalRows[0].sessionKey!
    expect(store.getState().moveSession(provisionalKey, folder)).toBe(true)
    // The provider session now arrives (the agent reported it).
    addSessionTestRecord(state, tab)
    const rowsAfterProvider = buildSidebarSessions(state)
    const providerKey = rowsAfterProvider[0].sessionKey!
    expect(providerKey).not.toBe(provisionalKey)
    // Nothing has migrated yet — this is what the effect in
    // use-sidebar-sessions.ts drives on every render of the sidebar.
    expect(getSessionFolderId(store.getState().metadata, providerKey)).toBeNull()
    applySessionFolderKeyMigrations(rowsAfterProvider, store.getState())
    expect(getSessionFolderId(store.getState().metadata, providerKey)).toBe(folder)
    expect(getSessionFolderId(store.getState().metadata, provisionalKey)).toBeNull()
    // A simulated restart: fresh store instance, fresh (but equivalent) source.
    const restarted = createSessionFoldersStore(adapter)
    restarted.getState().load()
    const restoredState = {
      ...state,
      tabsByWorktree: JSON.parse(JSON.stringify(state.tabsByWorktree)),
      terminalLayoutsByTabId: JSON.parse(JSON.stringify(state.terminalLayoutsByTabId)),
      sleepingAgentSessionsByPaneKey: JSON.parse(
        JSON.stringify(state.sleepingAgentSessionsByPaneKey)
      )
    }
    const restoredKey = buildSidebarSessions(restoredState)[0].sessionKey
    expect(restoredKey).toBe(providerKey)
    expect(getSessionFolderId(restarted.getState().metadata, restoredKey)).toBe(folder)
  })

  it('deletes a folder without altering sessions or another folder and persists Unfiled', () => {
    const { adapter } = diskStorage()
    const store = createSessionFoldersStore(adapter)
    store.getState().load()
    const one = store.getState().createFolder('One')!
    const two = store.getState().createFolder('Two')!
    store.getState().moveSession('session-a', one)
    store.getState().moveSession('session-b', two)
    store.getState().deleteFolder(one)
    const restarted = createSessionFoldersStore(adapter)
    restarted.getState().load()
    expect(restarted.getState().metadata.membership).toEqual({ 'session-b': two })
    expect(getSessionFolderId(restarted.getState().metadata, 'session-a')).toBeNull()
  })

  it('rejects invalid names and stale move destinations without changing saved metadata', () => {
    const { adapter } = diskStorage()
    const store = createSessionFoldersStore(adapter)
    store.getState().load()
    expect(store.getState().createFolder('  ')).toBeNull()
    store.getState().createFolder('Planning')
    expect(store.getState().createFolder(' planning ')).toBeNull()
    expect(store.getState().createFolder('x'.repeat(81))).toBeNull()
    expect(store.getState().moveSession('session-a', 'missing')).toBe(false)
    expect(adapter.load().folders).toHaveLength(1)
    expect(adapter.load().membership).toEqual({})
  })

  it('keeps disk contents intact when load fails and reports writes that cannot persist', () => {
    const { adapter, file } = diskStorage()
    writeFileSync(
      file,
      JSON.stringify({ [personalViewStorageKey(SESSION_FOLDERS_STORAGE_KEY)]: '{broken' })
    )
    const store = createSessionFoldersStore(adapter)
    store.getState().load()
    expect(store.getState().loaded).toBe(false)
    expect(store.getState().createFolder('No overwrite')).toBeNull()
    expect(readFileSync(file, 'utf8')).toContain('{broken')
    const failing = createSessionFoldersStore({
      load: () => ({ version: 1, folders: [], membership: {} }),
      save: () => {
        throw new Error('Storage full')
      }
    })
    failing.getState().load()
    expect(failing.getState().createFolder('Not saved')).toBeNull()
    expect(failing.getState().metadata.folders).toEqual([])
    expect(failing.getState().error).toContain('Could not save')
  })
})
