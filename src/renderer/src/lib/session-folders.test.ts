import { describe, expect, it } from 'vitest'
import { emptyProjectSettings } from '../../../shared/project-settings'
import {
  emptySessionFolderMetadata,
  getSessionFolderId,
  migrateSessionFolderKey,
  moveSessionToFolder
} from './session-folders'

const FOLDER_A = '00000000-0000-4000-8000-000000000001'
const FOLDER_B = '00000000-0000-4000-8000-000000000002'

describe('migrateSessionFolderKey', () => {
  it('moves a provisional key folder assignment onto the durable key and drops the old entry', () => {
    const base = { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_A, name: 'Planning' }] }
    const filed = moveSessionToFolder(base, 'provisional-key', FOLDER_A)
    const migrated = migrateSessionFolderKey(filed, 'provisional-key', 'provider-key')
    expect(getSessionFolderId(migrated, 'provisional-key')).toBeNull()
    expect(getSessionFolderId(migrated, 'provider-key')).toBe(FOLDER_A)
  })

  it('is a no-op when the provisional key was never filed', () => {
    const base = emptySessionFolderMetadata()
    const migrated = migrateSessionFolderKey(base, 'provisional-key', 'provider-key')
    expect(migrated).toBe(base)
  })

  it('is a no-op when from and to are the same key', () => {
    const base = { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_A, name: 'Planning' }] }
    const filed = moveSessionToFolder(base, 'same-key', FOLDER_A)
    expect(migrateSessionFolderKey(filed, 'same-key', 'same-key')).toBe(filed)
  })

  it('keeps a folder already chosen under the durable key and still drops the stale provisional entry', () => {
    const base = {
      ...emptySessionFolderMetadata(),
      folders: [
        { id: FOLDER_A, name: 'Planning' },
        { id: FOLDER_B, name: 'Later' }
      ]
    }
    const withBoth = moveSessionToFolder(
      moveSessionToFolder(base, 'provisional-key', FOLDER_A),
      'provider-key',
      FOLDER_B
    )
    const migrated = migrateSessionFolderKey(withBoth, 'provisional-key', 'provider-key')
    expect(getSessionFolderId(migrated, 'provisional-key')).toBeNull()
    expect(getSessionFolderId(migrated, 'provider-key')).toBe(FOLDER_B)
  })

  it('is idempotent: migrating twice has no further effect', () => {
    const base = { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_A, name: 'Planning' }] }
    const filed = moveSessionToFolder(base, 'provisional-key', FOLDER_A)
    const once = migrateSessionFolderKey(filed, 'provisional-key', 'provider-key')
    const twice = migrateSessionFolderKey(once, 'provisional-key', 'provider-key')
    expect(twice).toBe(once)
  })

  it("re-points a project's coordinator, even one never filed, and leaves other projects alone", () => {
    const launch = { agent: 'claude' as const }
    const base = {
      ...emptySessionFolderMetadata(),
      folders: [
        { id: FOLDER_A, name: 'Ads' },
        { id: FOLDER_B, name: 'Web' }
      ],
      projects: {
        [FOLDER_A]: {
          ...emptyProjectSettings(1),
          coordinator: { launch, sessionKey: 'provisional-key' }
        },
        [FOLDER_B]: emptyProjectSettings(2)
      }
    }
    const migrated = migrateSessionFolderKey(base, 'provisional-key', 'provider-key')
    expect(migrated.projects?.[FOLDER_A]?.coordinator).toEqual({
      launch,
      sessionKey: 'provider-key'
    })
    expect(migrated.projects?.[FOLDER_B]).toBe(base.projects[FOLDER_B])
    expect(migrated.membership).toEqual({})
    const filed = moveSessionToFolder(base, 'other-key', FOLDER_B)
    expect(migrateSessionFolderKey(filed, 'other-key', 'provider-key').projects).toBe(
      filed.projects
    )
  })
})
