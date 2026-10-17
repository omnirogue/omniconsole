import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import { selectedComputerWorkspace } from './selected-computer-workspace'

const folder = (id: string, owner: string, name = 'Work', isArchived = false) =>
  ({
    id,
    name,
    isArchived,
    projectGroupId: id,
    connectionId: null,
    executionHostId: `runtime:${owner}`
  }) as FolderWorkspace

describe('selected computer launch workspace', () => {
  it('chooses the selected computer instead of a tab on another computer', () => {
    expect(
      selectedComputerWorkspace(
        {
          activeWorktreeId: 'folder:studio',
          folderWorkspaces: [folder('studio', 'studio'), folder('worker', 'worker')]
        },
        'worker'
      )
    ).toBe('folder:worker')
  })
  it('never falls back to another computer when the chosen computer has no workspace', () => {
    expect(
      selectedComputerWorkspace({ folderWorkspaces: [folder('studio', 'studio')] }, 'worker')
    ).toBeNull()
  })
  it('prefers the Work folder and excludes archived workspaces', () => {
    expect(
      selectedComputerWorkspace(
        {
          folderWorkspaces: [
            folder('archived', 'worker', 'Work', true),
            folder('project', 'worker', 'Project'),
            folder('root', 'worker')
          ]
        },
        'worker'
      )
    ).toBe('folder:root')
  })
})
