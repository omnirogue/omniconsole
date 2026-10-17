import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { buildFolderWorkspaceAttachedRepo } from '../../../shared/folder-workspace-attached-repos'
import { FolderWorkspacePersistenceOperations } from './folder-workspace-operations'

const repo = {
  id: 'repo-1',
  path: '/work/omni-ide',
  displayName: 'omni-ide',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git' as const
}

function setup() {
  const state = {
    folderWorkspaces: [{ id: 'ops', name: 'Ops', sortOrder: 0 } as FolderWorkspace],
    workspaceSession: {}
  } as unknown as PersistedState
  const scheduleSave = vi.fn()
  const ops = new FolderWorkspacePersistenceOperations({
    state,
    scheduleSave,
    removeWorkspaceLineageForFolderParent: vi.fn(),
    pruneMobileClientTabSelections: vi.fn(),
    hydrateRepo: (value) => value
  })
  return { state, ops, scheduleSave }
}

describe('folder workspace attached repos', () => {
  it('attaches once per key and saves only on a real change', () => {
    const { ops, scheduleSave } = setup()
    const attachment = buildFolderWorkspaceAttachedRepo(repo, 'first-worktree', 1)
    expect(ops.attachRepoToFolderWorkspace('ops', attachment)).toHaveLength(1)
    expect(ops.attachRepoToFolderWorkspace('ops', { ...attachment, source: 'manual' })).toEqual([
      attachment
    ])
    expect(scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('refreshes the repo id and path when the same identity was re-registered', () => {
    const { ops } = setup()
    const attachment = buildFolderWorkspaceAttachedRepo(repo, 'manual', 1)
    ops.attachRepoToFolderWorkspace('ops', attachment)
    const [updated] = ops.attachRepoToFolderWorkspace('ops', {
      ...attachment,
      repoId: 'repo-2',
      repoPath: '/moved/omni-ide'
    })!
    expect(updated).toMatchObject({ repoId: 'repo-2', repoPath: '/moved/omni-ide', attachedAt: 1 })
  })

  it('updates one row when the same repo gains a remote identity (review F3)', () => {
    const { ops } = setup()
    ops.attachRepoToFolderWorkspace('ops', buildFolderWorkspaceAttachedRepo(repo, 'manual', 1))
    const enriched = buildFolderWorkspaceAttachedRepo(
      {
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.com/omnirogue/omni-ide',
          remoteName: 'origin',
          remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
        }
      },
      'detected-checkout',
      2
    )
    const list = ops.attachRepoToFolderWorkspace('ops', enriched)!
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ key: enriched.key, source: 'manual', attachedAt: 1 })
  })

  it('refuses an unknown folder and detaches by key', () => {
    const { ops } = setup()
    const attachment = buildFolderWorkspaceAttachedRepo(repo, 'manual', 1)
    expect(ops.attachRepoToFolderWorkspace('gone', attachment)).toBeNull()
    ops.attachRepoToFolderWorkspace('ops', attachment)
    expect(ops.detachRepoFromFolderWorkspace('ops', attachment.key)).toBe(true)
    expect(ops.detachRepoFromFolderWorkspace('ops', attachment.key)).toBe(false)
    expect(ops.getAllFolderWorkspaceAttachedRepos()).toEqual({})
  })

  it('drops a deleted folder workspace’s attachments', () => {
    const { ops, state } = setup()
    ops.attachRepoToFolderWorkspace('ops', buildFolderWorkspaceAttachedRepo(repo, 'manual', 1))
    expect(ops.removeFolderWorkspace('ops')).toBe(true)
    expect(state.folderWorkspaceAttachedRepos).toEqual({})
  })
})
