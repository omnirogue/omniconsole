import { describe, expect, it, vi } from 'vitest'
import { emptySessionSidebarView, type SessionSidebarView } from '@/lib/session-sidebar-view'
import { createSessionSidebarViewStore } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(key)
}))

/** A storage that keeps what it is handed, so load() reads back what save() wrote. */
function createStore() {
  let saved: SessionSidebarView = emptySessionSidebarView()
  const view = {
    save: vi.fn((next: SessionSidebarView) => {
      saved = next
    }),
    load: vi.fn(() => saved)
  }
  const archived = { save: vi.fn(), load: vi.fn((): readonly string[] => []) }
  return { store: createSessionSidebarViewStore(view, archived), view }
}

describe('session sidebar view store: work header fold', () => {
  it('starts a new window at Home while keeping organization and later in-window host choices', () => {
    const { store, view } = createStore()
    view.load.mockReturnValue({
      ...emptySessionSidebarView(),
      hostScope: 'runtime:studio',
      hostFilter: { kinds: ['runtime'], hiddenHostIds: [] },
      workHeaderCollapsed: { a: true }
    })
    store.getState().load()
    expect(store.getState().view.hostScope).toBe('local')
    expect(store.getState().view.hostFilter?.kinds).toEqual(['local'])
    expect(store.getState().view.workHeaderCollapsed).toEqual({ a: true })
    store.getState().setHostFilter({ kinds: ['runtime'], hiddenHostIds: [] }, 'runtime:studio')
    store.getState().load()
    expect(store.getState().view.hostScope).toBe('runtime:studio')
  })
  it('saves the fold to storage and reads it back on load', () => {
    const { store, view } = createStore()
    store.getState().load()
    store.getState().setWorkHeaderCollapsed('a', true)
    expect(view.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ workHeaderCollapsed: { a: true } })
    )
    store.getState().setWorkHeaderCollapsed('a', false)
    expect(store.getState().view.workHeaderCollapsed).toEqual({ a: false })
    const reloaded = createStore()
    reloaded.view.load.mockReturnValue(view.save.mock.lastCall![0] as SessionSidebarView)
    reloaded.store.getState().load()
    expect(reloaded.store.getState().view.workHeaderCollapsed).toEqual({ a: false })
  })

  it('follows a session key migration and leaves other keys alone', () => {
    const { store } = createStore()
    store.getState().load()
    store.getState().setWorkHeaderCollapsed('pane-key', true)
    store.getState().setWorkHeaderCollapsed('other', false)
    store.getState().migrateSessionKey('pane-key', 'provider-key')
    expect(store.getState().view.workHeaderCollapsed).toEqual({
      'provider-key': true,
      other: false
    })
    expect(store.getState().view.expandedRows ?? []).toEqual([])
  })

  it('migrates a key that only the fold record knows', () => {
    const { store, view } = createStore()
    store.getState().load()
    store.getState().setWorkHeaderCollapsed('only-here', true)
    view.save.mockClear()
    store.getState().migrateSessionKey('only-here', 'known')
    expect(view.save).toHaveBeenCalledTimes(1)
    expect(store.getState().view.workHeaderCollapsed).toEqual({ known: true })
    store.getState().migrateSessionKey('absent', 'elsewhere')
    expect(view.save).toHaveBeenCalledTimes(1)
  })

  it('keeps the on-screen fold when the device cannot save', () => {
    const { store, view } = createStore()
    view.save.mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => store.getState().setWorkHeaderCollapsed('a', true)).not.toThrow()
    expect(store.getState().view.workHeaderCollapsed).toEqual({ a: true })
  })
})
