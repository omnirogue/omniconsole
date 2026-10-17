import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${key}:test`,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(`${key}:test`)
}))

import { createLocalSessionFolderStorage } from '@/lib/session-folder-storage'
import { createLocalSessionSidebarViewStorage } from '@/lib/session-sidebar-view-storage'
import { createSessionFoldersStore } from '@/store/session-folders'
import {
  createSessionSidebarViewStore,
  type SessionArchivedStorage
} from '@/store/session-sidebar-view'
import {
  mergeLegacyRoutineSidebar,
  ROUTINE_FOLDERS_STORAGE_KEY,
  ROUTINE_SIDEBAR_ARCHIVED_STORAGE_KEY,
  ROUTINE_SIDEBAR_VIEW_STORAGE_KEY
} from './routine-sidebar-stores'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value)
  }
}

function conversationStores(storage: ReturnType<typeof memoryStorage>) {
  const archived: SessionArchivedStorage = { load: () => [], save: () => {} }
  const folders = createSessionFoldersStore(createLocalSessionFolderStorage(() => storage))
  const view = createSessionSidebarViewStore(
    createLocalSessionSidebarViewStorage(() => storage),
    archived
  )
  folders.getState().load()
  view.getState().load()
  return { folders, view }
}

/** What the retired Routines tab left behind: a "Money" folder, one hidden and one archived routine. */
function seedLegacy(storage: ReturnType<typeof memoryStorage>): void {
  const folders = createSessionFoldersStore(
    createLocalSessionFolderStorage(() => storage, ROUTINE_FOLDERS_STORAGE_KEY)
  )
  const view = createSessionSidebarViewStore(
    createLocalSessionSidebarViewStorage(() => storage, ROUTINE_SIDEBAR_VIEW_STORAGE_KEY),
    { load: () => [], save: () => {} }
  )
  folders.getState().load()
  view.getState().load()
  const money = folders.getState().createFolder('Money')!
  folders.getState().moveSessions(['routine:local:a', 'routine:local:b'], money)
  view.getState().setHidden('routine:routine:local:c', true)
  storage.setItem(
    `${ROUTINE_SIDEBAR_ARCHIVED_STORAGE_KEY}:test`,
    JSON.stringify(['routine:local:d'])
  )
}

describe('carrying the Routines tab into Conversations', () => {
  it('files, hides and archives each routine where the person left it', () => {
    const storage = memoryStorage()
    seedLegacy(storage)
    const { folders, view } = conversationStores(storage)
    const existing = folders.getState().createFolder('money')!

    mergeLegacyRoutineSidebar(storage, folders, view)

    const metadata = folders.getState().metadata
    // Why: a same-named conversation folder is joined, not duplicated.
    expect(metadata.folders.map((folder) => folder.name)).toEqual(['money'])
    expect(metadata.membership).toEqual({
      'routine:local:a': existing,
      'routine:local:b': existing
    })
    expect(view.getState().view.hidden).toEqual(['routine:routine:local:c'])
    expect(view.getState().archived).toEqual(['routine:local:d'])
  })

  it('runs once, so a routine unfiled later is not filed again', () => {
    const storage = memoryStorage()
    seedLegacy(storage)
    const { folders, view } = conversationStores(storage)
    mergeLegacyRoutineSidebar(storage, folders, view)
    folders.getState().moveSession('routine:local:a', null)

    mergeLegacyRoutineSidebar(storage, folders, view)

    expect(Object.keys(folders.getState().metadata.membership)).toEqual(['routine:local:b'])
  })

  it('waits until both Conversations stores have loaded', () => {
    const storage = memoryStorage()
    seedLegacy(storage)
    const folders = createSessionFoldersStore(createLocalSessionFolderStorage(() => storage))
    const view = createSessionSidebarViewStore(
      createLocalSessionSidebarViewStorage(() => storage),
      { load: () => [], save: () => {} }
    )

    mergeLegacyRoutineSidebar(storage, folders, view)
    folders.getState().load()
    view.getState().load()
    mergeLegacyRoutineSidebar(storage, folders, view)

    expect(folders.getState().metadata.folders.map((folder) => folder.name)).toEqual(['Money'])
  })
})
