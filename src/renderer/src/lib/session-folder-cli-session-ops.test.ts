import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { applyArchiveSessionBatch } from './session-folder-cli-session-ops'
import { emptySessionSidebarView } from './session-sidebar-view'
import { emptySessionFolderMetadata } from './session-folders'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

function stores() {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => emptySessionFolderMetadata())
  })
  const save = vi.fn()
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save, load: vi.fn(() => []) }
  )
  view.getState().load()
  return { folders, view, save }
}

const sessions = [
  { key: 'one', label: 'First' },
  { key: 'two', label: 'Second' }
]

describe('archive transferred sources together', () => {
  it('changes the archive store once for all sources', () => {
    const state = stores()
    state.save.mockClear()
    const result = applyArchiveSessionBatch(state, sessions)
    expect(state.view.getState().archived).toEqual(['one', 'two'])
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(result.map((entry) => entry.result.sessionKey)).toEqual(['one', 'two'])
  })

  it('validates every source before archiving any of them', () => {
    const state = stores()
    state.view.getState().setArchived(['two'], true)
    state.save.mockClear()
    expect(() => applyArchiveSessionBatch(state, sessions)).toThrow('already archived')
    expect(state.view.getState().archived).toEqual(['two'])
    expect(state.save).not.toHaveBeenCalled()
  })
})

describe('unarchive from the CLI', () => {
  it("takes back an automatic archive and keeps the row visible, as the row's Unarchive does", () => {
    const state = stores()
    expect(state.view.getState().archiveVerified('one', 'seal-1')).toBe(true)
    expect(state.view.getState().archived).toEqual(['one'])

    const [outcome] = applyArchiveSessionBatch(state, [sessions[0]!], false)

    expect(outcome!.result.summary).toBe('Unarchived “First”')
    const { view, archived } = state.view.getState()
    expect(archived).toEqual([])
    expect(view.autoArchiveKeep).toEqual(['one'])
    expect(view.autoArchiveLog?.[0]).toMatchObject({ key: 'one', proof: 'seal-1' })
    expect(view.autoArchiveLog?.[0]?.restoredAt).toEqual(expect.any(Number))
    // The keep-visible choice holds: the same finish is never filed again on its own.
    expect(state.view.getState().archiveVerified('one', 'seal-1')).toBe(false)
  })

  it('refuses a conversation that is not archived at all', () => {
    const state = stores()
    expect(() => applyArchiveSessionBatch(state, [sessions[0]!], false)).toThrow(
      '“First” is not archived, so there is nothing to unarchive.'
    )
  })
})
