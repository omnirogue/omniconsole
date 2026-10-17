import { beforeEach, describe, expect, it, vi } from 'vitest'
import { noteSessionFolderEdit } from '@/lib/account-sync/session-organization-intent'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptyProjectSettings } from '../../../shared/project-settings'
import { createSessionFoldersStore } from './session-folders'

vi.mock('@/lib/account-sync/session-organization-intent', () => ({
  noteSessionFolderEdit: vi.fn()
}))

const FOLDER = '00000000-0000-4000-8000-000000000001'
const SAVED = '00000000-0000-4000-8000-000000000002'

function createStore(coordinatorKey?: string) {
  const store = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => ({
      ...emptySessionFolderMetadata(),
      folders: [
        { id: FOLDER, name: 'Later' },
        { id: SAVED, name: 'Kept', section: 'saved' as const }
      ],
      membership: { kept: SAVED },
      ...(coordinatorKey
        ? {
            projects: {
              [FOLDER]: {
                ...emptyProjectSettings(1),
                coordinator: { launch: { agent: 'codex' as const }, sessionKey: coordinatorKey }
              }
            }
          }
        : {})
    }))
  })
  store.getState().load()
  return store
}

/** The membership each noted edit went from and to. */
const notedMoves = () =>
  vi
    .mocked(noteSessionFolderEdit)
    .mock.calls.map(([before, after]) => [before.membership, after.membership])

beforeEach(() => {
  vi.mocked(noteSessionFolderEdit).mockClear()
})

describe('session folders store: what account sync counts as the person’s own change', () => {
  it('notes each folder action once it is saved, and nothing that failed', () => {
    const store = createStore()
    expect(store.getState().moveSessions(['a'], 'missing')).toBe(false)
    expect(noteSessionFolderEdit).not.toHaveBeenCalled()
    store.getState().moveSessions(['a', 'b'], FOLDER)
    store.getState().moveSession('a', null)
    store.getState().saveSession('c', SAVED)
    expect(notedMoves()).toEqual([
      [{ kept: SAVED }, { kept: SAVED, a: FOLDER, b: FOLDER }],
      [
        { kept: SAVED, a: FOLDER, b: FOLDER },
        { kept: SAVED, b: FOLDER }
      ],
      [
        { kept: SAVED, b: FOLDER },
        { kept: SAVED, b: FOLDER, c: SAVED }
      ]
    ])
  })

  it('notes “Finish for me” taking a session out of Saved, and folder edits', () => {
    const store = createStore()
    store.getState().finishForMe('kept', { action: 'me', folderId: null })
    expect(notedMoves().at(-1)).toEqual([{ kept: SAVED }, {}])
    store.getState().renameFolder(FOLDER, 'Soon')
    store.getState().deleteFolder(SAVED)
    const [before, after] = vi.mocked(noteSessionFolderEdit).mock.calls.at(-1)!
    expect(before.folders.map((folder) => folder.id)).toEqual([FOLDER, SAVED])
    expect(after.folders.map((folder) => folder.id)).toEqual([FOLDER])
    expect(vi.mocked(noteSessionFolderEdit)).toHaveBeenCalledTimes(3)
  })

  it('notes only the coordinator a key move re-points, so the account’s copy keeps up', () => {
    const store = createStore('pane-key')
    expect(store.getState().migrateSessionKey('kept', 'provider-kept')).toBe(true)
    expect(noteSessionFolderEdit).not.toHaveBeenCalled()
    expect(store.getState().migrateSessionKey('pane-key', 'provider-key')).toBe(true)
    const [before, after] = vi.mocked(noteSessionFolderEdit).mock.calls.at(-1)!
    expect(after.membership).toBe(before.membership)
    expect(after.projects?.[FOLDER]?.coordinator?.sessionKey).toBe('provider-key')
    expect(store.getState().metadata.projects?.[FOLDER]?.coordinator?.sessionKey).toBe(
      'provider-key'
    )
    expect(vi.mocked(noteSessionFolderEdit)).toHaveBeenCalledTimes(1)
  })
})
