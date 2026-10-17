import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { pickSourceControlPollingTarget } from './use-source-control-target'

const worktree = { id: 'repo-1::/work/app-feature', hostId: 'local' } as Worktree

describe('pickSourceControlPollingTarget (review F4)', () => {
  const target = { kind: 'target' as const, folderWorkspaceId: 'ops', worktree, candidates: [] }

  it('polls a folder’s attached worktree only while Source Control is on screen', () => {
    expect(pickSourceControlPollingTarget(target, true, 'folder:ops')).toEqual({
      worktreeId: worktree.id,
      hostId: 'local'
    })
    expect(pickSourceControlPollingTarget(target, false, 'folder:ops')).toEqual({
      worktreeId: 'folder:ops'
    })
  })

  it('leaves ordinary worktrees and folders with nothing to show alone', () => {
    expect(pickSourceControlPollingTarget({ kind: 'not-folder' }, true, 'wt-1')).toEqual({
      worktreeId: 'wt-1'
    })
    expect(
      pickSourceControlPollingTarget(
        { kind: 'needs-attach', folderWorkspaceId: 'ops' },
        true,
        'folder:ops'
      )
    ).toEqual({ worktreeId: null })
  })
})
