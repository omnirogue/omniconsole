import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from './session-folders'
import {
  emptySessionFolderMetadata,
  parseSessionFolderMetadata,
  type SessionFolderMetadata
} from '@/lib/session-folders'

vi.mock('@/lib/account-sync/session-organization-intent', () => ({
  noteSessionFolderEdit: vi.fn()
}))

describe('durable transfer filing receipt', () => {
  it('persists placement and receipt together and survives a new store instance', () => {
    let disk = JSON.stringify(emptySessionFolderMetadata())
    const storage = {
      load: () => parseSessionFolderMetadata(JSON.parse(disk)),
      save: vi.fn((metadata: SessionFolderMetadata) => {
        disk = JSON.stringify(metadata)
      })
    }
    const store = createSessionFoldersStore(storage)
    store.getState().load()
    expect(store.getState().moveSessionDurably('session', 'saved-sessions', 'op')).toBe(true)
    expect(storage.save).toHaveBeenCalledTimes(1)
    const reloaded = createSessionFoldersStore(storage)
    reloaded.getState().load()
    expect(reloaded.getState().metadata.membership.session).toBe('saved-sessions')
    expect(reloaded.getState().readTransferReceipt('op')).toMatchObject({
      sessionKey: 'session',
      folderId: 'saved-sessions'
    })
    expect(reloaded.getState().moveSessionDurably('session', null, 'op')).toBe(false)
    expect(storage.save).toHaveBeenCalledTimes(1)
  })
  it('never reports a receipt or changes memory when the durable save fails', () => {
    const storage = {
      load: emptySessionFolderMetadata,
      save: () => {
        throw new Error('disk full')
      }
    }
    const store = createSessionFoldersStore(storage)
    store.getState().load()
    expect(store.getState().moveSessionDurably('session', 'saved-sessions', 'op')).toBe(false)
    expect(store.getState().metadata.membership).toEqual({})
    expect(store.getState().readTransferReceipt('op')).toBeNull()
  })
})
