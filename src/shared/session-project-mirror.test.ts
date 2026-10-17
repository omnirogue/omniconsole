import { describe, expect, it } from 'vitest'
import { emptyProjectSettings } from './project-settings'
import { parseSessionProjectMirror, readProjectFromFolders } from './session-project-mirror'

const settings = { ...emptyProjectSettings(1), repos: [{ gitIdentity: 'github.com/acme/web' }] }
const folders = [
  { id: 'co', name: 'OmniRogue', path: 'OmniRogue', section: 'active' as const, parentId: null },
  { id: 'ads', name: 'Ads', path: 'OmniRogue / Ads', section: 'active' as const, parentId: 'co' },
  {
    id: 'reviews',
    name: 'Reviews',
    path: 'OmniRogue / Ads / Reviews',
    section: 'active' as const,
    parentId: 'ads'
  }
]

describe('readProjectFromFolders', () => {
  it('finds the project a folder is in by id or path, as the window does', () => {
    const read = readProjectFromFolders(folders, { ads: settings }, 'OmniRogue / Ads / Reviews')
    expect(read).toEqual({
      folder: { id: 'reviews', name: 'Reviews', path: 'OmniRogue / Ads / Reviews' },
      project: { folderId: 'ads', name: 'Ads', path: 'OmniRogue / Ads', settings }
    })
    expect(readProjectFromFolders(folders, {}, 'ads').project?.settings).toBeNull()
    expect(readProjectFromFolders(folders, {}, 'co').project).toBeNull()
  })

  it('names a folder it cannot find', () => {
    expect(() => readProjectFromFolders(folders, {}, 'Nowhere')).toThrow()
  })
})

describe('parseSessionProjectMirror', () => {
  it('keeps valid projects and leaves out a malformed one', () => {
    const parsed = parseSessionProjectMirror({
      folders: [...folders, { id: 7 }],
      projects: { ads: settings, broken: { repos: 'x' } },
      savedAt: 5
    })
    expect(parsed?.folders).toHaveLength(3)
    expect(Object.keys(parsed?.projects ?? {})).toEqual(['ads'])
    expect(parseSessionProjectMirror('nope')).toBeNull()
  })
})
