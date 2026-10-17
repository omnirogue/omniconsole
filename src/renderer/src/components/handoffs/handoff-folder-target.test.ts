import { expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { findHandoffFolderGroup, handoffFolderGroupName } from './handoff-folder-target'

const group = { id: 'local-group', parentPath: '/work', executionHostId: 'local' } as ProjectGroup
it('matches only the local group for a picked local folder', () => {
  const groups = [
    { ...group, id: 'ssh', connectionId: 'remote', executionHostId: 'ssh:remote' },
    { ...group, id: 'runtime', executionHostId: 'runtime:remote' },
    { ...group, id: 'other', parentPath: '/other' },
    group
  ]
  expect(findHandoffFolderGroup(groups, '/work/')).toBe(group)
  expect(findHandoffFolderGroup(groups, '/missing')).toBeUndefined()
})
it.each([
  ['/work/reports/', 'reports'],
  ['C:\\Work\\Reports\\', 'Reports'],
  ['/', '/']
])('names a group from the picked path %s', (path, name) => {
  expect(handoffFolderGroupName(path)).toBe(name)
})
