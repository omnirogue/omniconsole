import { describe, expect, it, vi } from 'vitest'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { createSessionFoldersStore } from './session-folders'

const FOLDER = '00000000-0000-4000-8000-000000000001'

function createStore() {
  const storage = {
    save: vi.fn(),
    load: vi.fn(() => ({
      ...emptySessionFolderMetadata(),
      folders: [{ id: FOLDER, name: 'Later' }]
    }))
  }
  const store = createSessionFoldersStore(storage)
  store.getState().load()
  return { store, storage }
}

describe('session folders store: moveSessions', () => {
  it('files a whole selection with one save', () => {
    const { store, storage } = createStore()
    expect(store.getState().moveSessions(['a', 'b'], FOLDER)).toBe(true)
    expect(store.getState().metadata.membership).toEqual({ a: FOLDER, b: FOLDER })
    expect(storage.save).toHaveBeenCalledTimes(1)
    expect(store.getState().moveSessions(['a'], null)).toBe(true)
    expect(store.getState().metadata.membership).toEqual({ b: FOLDER })
    expect(storage.save).toHaveBeenCalledTimes(2)
  })

  it('moves nobody when one key or the folder is bad', () => {
    const { store, storage } = createStore()
    expect(store.getState().moveSessions(['a', ''], FOLDER)).toBe(false)
    expect(store.getState().metadata.membership).toEqual({})
    expect(store.getState().error).toBe('Session identity is unavailable.')
    expect(store.getState().moveSessions(['a'], 'missing')).toBe(false)
    expect(store.getState().error).toBe('This folder no longer exists.')
    expect(storage.save).not.toHaveBeenCalled()
  })
})
