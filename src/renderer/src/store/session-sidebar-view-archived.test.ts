import { describe, expect, it, vi } from 'vitest'
import { noteSessionsArchived } from '@/lib/account-sync/session-organization-intent'
import { emptySessionSidebarView, type SessionSidebarView } from '@/lib/session-sidebar-view'
import {
  currentArchiveExecutor,
  onConversationArchiveChange,
  withArchiveExecutor,
  type ConversationArchiveEvent
} from '@/lib/session-archive-events'
import { createSessionSidebarViewStore } from './session-sidebar-view'
import { announceArchiveChanges } from './session-sidebar-view-archive-notices'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/lib/account-sync/session-organization-intent', () => ({ noteSessionsArchived: vi.fn() }))

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(key)
}))

function createStore() {
  const view = { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) }
  const archived = {
    save: vi.fn(),
    load: vi.fn((): readonly string[] => ['old'])
  }
  const store = createSessionSidebarViewStore(view, archived)
  return { store, view, archived }
}

describe('session sidebar view store: archived list and batched writes', () => {
  it('refuses automatic filing after a failed load instead of forgetting keep-visible choices', () => {
    const { store, view } = createStore()
    view.load.mockImplementationOnce(() => {
      throw new Error('unreadable')
    })
    store.getState().load()
    expect(store.getState().archiveVerified('session', 'proof')).toBe(false)
    store.getState().setCollapsed(['waiting'], false)
    expect(view.save).not.toHaveBeenCalled()
    store.getState().load()
    expect(store.getState().archiveVerified('session', 'proof')).toBe(true)
  })

  it('shows a failed Undo save and suspends automatic filing while keeping the session visible', () => {
    const { store, view } = createStore()
    store.getState().load()
    store.getState().archiveVerified('session', 'proof')
    view.save.mockImplementationOnce(() => {
      throw new Error('full')
    })
    store.getState().setArchived(['session'], false)
    expect(store.getState().archived).not.toContain('session')
    expect(store.getState().archiveStorageReady).toBe(false)
    expect(toast.error).toHaveBeenCalled()
    expect(store.getState().archiveVerified('other', 'proof')).toBe(false)
  })
  it('requires durable automatic filing and preserves Undo across reload and identity migration', () => {
    const { store, view } = createStore()
    store.getState().load()
    view.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(false)
    expect(store.getState().archived).not.toContain('pane')
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(true)
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(false)
    store.getState().setArchived(['pane'], false)
    store.getState().migrateSessionKey('pane', 'provider')
    expect(store.getState().view.autoArchiveKeep).toContain('provider')
    expect(store.getState().view.autoArchiveLog).toEqual([
      expect.objectContaining({ key: 'provider', proof: 'proof', restoredAt: expect.any(Number) })
    ])
    view.load.mockReturnValue(store.getState().view)
    store.getState().load()
    expect(store.getState().archiveVerified('provider', 'proof')).toBe(false)
  })

  it('restores resumed work without preventing a later independently verified completion', () => {
    const { store } = createStore()
    store.getState().load()
    store.getState().archiveVerified('session', 'first')
    store.getState().setArchived(['session'], false, 'resume')
    expect(store.getState().archiveVerified('session', 'second')).toBe(true)
    expect(store.getState().view.autoArchiveLog).toHaveLength(2)
  })
  it('loads the hand-archived list beside the view', () => {
    const { store } = createStore()
    store.getState().load()
    expect(store.getState().archived).toEqual(['old'])
    expect(store.getState().view.archived).toEqual(['old'])
    expect(store.getState().loaded).toBe(true)
  })

  it('prefers the published view archive over the older candidate storage slot', () => {
    const { store, view } = createStore()
    view.load.mockReturnValue({ ...emptySessionSidebarView(), archived: [] })
    store.getState().load()
    expect(store.getState().archived).toEqual([])
    store.getState().setArchived(['current'], true)
    expect(store.getState().view.archived).toEqual(['current'])
    expect(view.save).toHaveBeenCalledWith(expect.objectContaining({ archived: ['current'] }))
  })

  it('archives and unarchives keys with one save per call', () => {
    const { store, archived } = createStore()
    store.getState().load()
    store.getState().setArchived(['a', 'b', 'a'], true)
    expect(store.getState().archived).toEqual(['old', 'a', 'b'])
    expect(archived.save).toHaveBeenCalledTimes(1)
    store.getState().setArchived(['a', 'old'], false)
    expect(store.getState().archived).toEqual(['b'])
    expect(archived.save).toHaveBeenCalledTimes(2)
    store.getState().setArchived([], true)
    expect(archived.save).toHaveBeenCalledTimes(2)
  })

  it('records the person’s archiving for account sync, but not a change the sync applies', () => {
    const { store } = createStore()
    store.getState().load()
    vi.mocked(noteSessionsArchived).mockClear()
    store.getState().setArchived(['a'], false, 'account-sync')
    store.getState().setArchived(['b'], true, 'account-sync')
    expect(noteSessionsArchived).not.toHaveBeenCalled()
    store.getState().setArchived(['a'], true)
    store.getState().setArchived(['old'], false)
    expect(vi.mocked(noteSessionsArchived).mock.calls).toEqual([[['a']], [['old']]])
  })

  it('keeps the on-screen change when the device cannot save', () => {
    const { store, archived } = createStore()
    archived.save.mockImplementation(() => {
      throw new Error('quota')
    })
    store.getState().setArchived(['a'], true)
    expect(store.getState().archived).toEqual(['a'])
  })

  it('hides many rows with a single view save', () => {
    const { store, view } = createStore()
    store.getState().setHiddenMany(['conversation:a', 'conversation:b'], true)
    expect(store.getState().view.hidden).toEqual(['conversation:a', 'conversation:b'])
    expect(view.save).toHaveBeenCalledTimes(1)
    store.getState().setHiddenMany([], true)
    expect(view.save).toHaveBeenCalledTimes(1)
    store.getState().setHiddenMany(['conversation:a'], false)
    expect(store.getState().view.hidden).toEqual(['conversation:b'])
  })

  it('carries an archived mark across a session key migration', () => {
    const { store } = createStore()
    store.getState().setArchived(['pane-key'], true)
    store.getState().migrateSessionKey('pane-key', 'provider-key')
    expect(store.getState().archived).toEqual(['provider-key'])
  })

  it('remembers which rows are expanded in the saved view and follows a key migration', () => {
    const { store, view } = createStore()
    store.getState().load()
    store.getState().setRowExpanded('a', true)
    expect(store.getState().view.expandedRows).toEqual(['a'])
    expect(view.save).toHaveBeenLastCalledWith(expect.objectContaining({ expandedRows: ['a'] }))
    store.getState().migrateSessionKey('a', 'b')
    expect(store.getState().view.expandedRows).toEqual(['b'])
    store.getState().setRowExpanded('b', false)
    expect(store.getState().view.expandedRows).toEqual([])
  })
})

describe('session sidebar view store: archive notices', () => {
  function notified() {
    const events: ConversationArchiveEvent[] = []
    const { store, view } = createStore()
    announceArchiveChanges(store, (event) => events.push(event))
    return { store, view, events }
  }

  it('announces each archive and unarchive with the executor that asked', () => {
    const { store, events } = notified()
    store.getState().load()
    withArchiveExecutor('person', () => store.getState().setArchived(['a'], true))
    store.getState().setArchived(['b'], true, 'account-sync')
    withArchiveExecutor('pane', () =>
      withArchiveExecutor('cli', () => store.getState().setArchived(['c'], true))
    )
    // Why unknown: a path that names no executor must never count as a person's archive.
    store.getState().setArchived(['d'], true)
    withArchiveExecutor('person', () => store.getState().setArchived(['a', 'c', 'd'], false))
    store.getState().setArchived(['b'], false, 'resume')
    store.getState().setArchived([], true)
    expect(store.getState().archived).toEqual(['old'])
    expect(events).toEqual([
      { keys: ['a'], archived: true, via: 'person' },
      { keys: ['b'], archived: true, via: 'sync' },
      { keys: ['c'], archived: true, via: 'cli' },
      { keys: ['d'], archived: true, via: 'unknown' },
      { keys: ['a', 'c', 'd'], archived: false, via: 'person' },
      { keys: ['b'], archived: false, via: 'resume' }
    ])
    expect(currentArchiveExecutor()).toBeNull()
  })

  it('names the steward when it files a verified archive', () => {
    const { store, events } = notified()
    store.getState().load()
    withArchiveExecutor('steward', () => store.getState().archiveVerified('pane', 'proof'))
    expect(events).toEqual([{ keys: ['pane'], archived: true, via: 'steward' }])
  })

  it('announces automatic filing only when the receipt was saved', () => {
    const { store, view, events } = notified()
    store.getState().load()
    view.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(false)
    expect(events).toEqual([])
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(true)
    expect(store.getState().archiveVerified('pane', 'proof')).toBe(false)
    expect(events).toEqual([{ keys: ['pane'], archived: true, via: 'auto-archive' }])
  })

  it('announces a committed transfer archive, never a refused one', () => {
    let saved: SessionSidebarView = emptySessionSidebarView()
    const storage = {
      save: vi.fn((next: SessionSidebarView) => {
        saved = next
      }),
      load: vi.fn(() => saved)
    }
    const events: ConversationArchiveEvent[] = []
    const store = createSessionSidebarViewStore(storage, { save: vi.fn(), load: () => [] })
    announceArchiveChanges(store, (event) => events.push(event))
    store.getState().load()
    expect(() => store.getState().archiveTransfer(['other'], 'op-0', () => false)).toThrow()
    store.getState().archiveTransfer(['source'], 'op-1', () => true)
    expect(store.getState().archived).toEqual(['source'])
    expect(events).toEqual([{ keys: ['source'], archived: true, via: 'transfer' }])
  })

  it('never announces loading the list or migrating a key', () => {
    const { store, events } = notified()
    store.getState().load()
    store.getState().migrateSessionKey('old', 'provider')
    expect(store.getState().archived).toEqual(['provider'])
    expect(events).toEqual([])
  })

  it('an unwrapped store never reaches the window listeners', () => {
    const heard = vi.fn()
    const off = onConversationArchiveChange(heard)
    const { store } = createStore()
    store.getState().load()
    store.getState().setArchived(['a'], true)
    store.getState().archiveVerified('b', 'proof')
    off()
    expect(heard).not.toHaveBeenCalled()
  })
})
