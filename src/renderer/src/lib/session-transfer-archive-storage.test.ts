import { describe, expect, it, vi } from 'vitest'
import { emptySessionSidebarView, parseSessionSidebarView } from './session-sidebar-view'
import {
  persistTransferArchive,
  readTransferArchiveReceipt,
  recoverTransferArchiveProjections
} from './session-transfer-archive-storage'

function fixture() {
  let stored = JSON.stringify(emptySessionSidebarView())
  const storage = {
    load: () => parseSessionSidebarView(JSON.parse(stored)),
    save: vi.fn((view: ReturnType<typeof emptySessionSidebarView>) => {
      stored = JSON.stringify(view)
    })
  }
  return { storage, initial: storage.load() }
}

describe('durable transfer archive', () => {
  it('reloads every source and the exact receipt from a single storage write', () => {
    const { storage, initial } = fixture()
    persistTransferArchive(storage, initial, ['a', 'b'], 'operation', () => true)
    expect(storage.save).toHaveBeenCalledOnce()
    expect(storage.load().archived).toEqual(['a', 'b'])
    expect(readTransferArchiveReceipt(storage, 'operation')).toEqual(['a', 'b'])
    expect(readTransferArchiveReceipt(storage, 'different-operation')).toBeNull()
  })

  it('a quota failure produces no successful receipt or partial batch', () => {
    const { storage, initial } = fixture()
    storage.save.mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() =>
      persistTransferArchive(storage, initial, ['a', 'b'], 'operation', () => true)
    ).toThrow('quota')
    expect(storage.load().archived).toBeUndefined()
    expect(readTransferArchiveReceipt(storage, 'operation')).toBeNull()
  })

  it('checks the final guard after preparing the batch and before any write', () => {
    const { storage, initial } = fixture()
    expect(() =>
      persistTransferArchive(storage, initial, ['a', 'b'], 'operation', () => false)
    ).toThrow('checkpoint changed')
    expect(storage.save).not.toHaveBeenCalled()
  })

  it('does not claim success from an earlier receipt after Undo', () => {
    const { storage, initial } = fixture()
    const view = persistTransferArchive(storage, initial, ['a', 'b'], 'operation', () => true)
    storage.save({ ...view, archived: ['a'] })
    expect(readTransferArchiveReceipt(storage, 'operation')).toBeNull()
  })
})

describe('archive projection recovery', () => {
  const scope = 'omni.session-sidebar-view.v1:person'
  it('projects a main-committed operation after a renderer crash and acknowledges only after saving', () => {
    const { storage, initial } = fixture()
    const durable = { ...storage, projectionScope: () => scope }
    const api = {
      pendingSessionTransferArchives: vi.fn(() => [{ operationId: 'committed', keys: ['a', 'b'] }]),
      acknowledgeSessionTransferArchive: vi.fn(() => {
        expect(readTransferArchiveReceipt(storage, 'committed')).toEqual(['a', 'b'])
        return true
      })
    }
    recoverTransferArchiveProjections(durable, initial, api)
    expect(api.pendingSessionTransferArchives).toHaveBeenCalledWith(scope)
    expect(api.acknowledgeSessionTransferArchive).toHaveBeenCalledWith(scope, 'committed')
    expect(storage.save).toHaveBeenCalledOnce()
  })
  it('does not undo a later personal Undo when main missed the projection acknowledgement', () => {
    const { storage, initial } = fixture()
    const archived = persistTransferArchive(storage, initial, ['a', 'b'], 'committed', () => true)
    storage.save({ ...archived, archived: [] })
    storage.save.mockClear()
    const api = {
      pendingSessionTransferArchives: () => [{ operationId: 'committed', keys: ['a', 'b'] }],
      acknowledgeSessionTransferArchive: vi.fn(() => true)
    }
    const recovered = recoverTransferArchiveProjections(
      { ...storage, projectionScope: () => scope },
      storage.load(),
      api
    )
    expect(recovered.archived).toEqual([])
    expect(storage.save).not.toHaveBeenCalled()
    expect(api.acknowledgeSessionTransferArchive).toHaveBeenCalledOnce()
  })
  it('retains a pending main decision when storage rejects the projection', () => {
    const { storage, initial } = fixture()
    storage.save.mockImplementation(() => {
      throw new Error('quota')
    })
    const api = {
      pendingSessionTransferArchives: () => [{ operationId: 'committed', keys: ['a'] }],
      acknowledgeSessionTransferArchive: vi.fn(() => true)
    }
    const recovered = recoverTransferArchiveProjections(
      { ...storage, projectionScope: () => scope },
      initial,
      api
    )
    expect(recovered.archived).toBeUndefined()
    expect(api.acknowledgeSessionTransferArchive).not.toHaveBeenCalled()
  })
  it('retains acknowledged progress when a later projection fails and the sidebar saves again', () => {
    const { storage, initial } = fixture()
    storage.save({ ...initial, archived: ['old'] })
    const save = storage.save.getMockImplementation()!
    storage.save.mockImplementation((view) => {
      if (view.archived?.includes('b')) {
        throw new Error('quota')
      }
      save(view)
    })
    const api = {
      pendingSessionTransferArchives: () => [
        { operationId: 'first', keys: ['a'] },
        { operationId: 'second', keys: ['b'] }
      ],
      acknowledgeSessionTransferArchive: vi.fn(() => true)
    }
    const recovered = recoverTransferArchiveProjections(
      { ...storage, projectionScope: () => scope },
      initial,
      api
    )
    expect(recovered.archived).toEqual(['old', 'a'])
    expect(api.acknowledgeSessionTransferArchive.mock.calls).toEqual([[scope, 'first']])
    storage.save({ ...recovered, density: 'compact' })
    expect(storage.load().archived).toEqual(['old', 'a'])
    expect(readTransferArchiveReceipt(storage, 'first')).toEqual(['a'])
  })

  it('projects against fresh canonical metadata after an earlier load used an empty fallback', () => {
    const { storage, initial } = fixture()
    storage.save({
      ...initial,
      hidden: ['keep'],
      archived: ['old'],
      transferArchiveReceipts: { previous: ['old'] }
    })
    const projected = persistTransferArchive(storage, initial, ['a'], 'new', () => true)
    expect(projected.hidden).toEqual(['keep'])
    expect(projected.archived).toEqual(['old', 'a'])
    expect(projected.transferArchiveReceipts).toEqual({ previous: ['old'], new: ['a'] })
  })
})
