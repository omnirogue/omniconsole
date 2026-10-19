import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { FolderWorkspaceAttachedRepo } from '../../shared/folder-workspace-attached-repos'
import type { Repo } from '../../shared/repo-types'
import {
  attachRepoOnFolderWorktreeCreate,
  resolveFolderWorkspaceJobRepo,
  resolveFolderWorkspaceRepoForCreate
} from './folder-workspace-attached-repo-runtime'

vi.mock('../ipc/repos/nested-repo-scan-ipc', () => ({ scanNestedReposForIpc: vi.fn() }))

const folder = { id: 'ops', name: 'Ops', folderPath: '/work/ops' } as FolderWorkspace
const omni: Repo = {
  id: 'repo-omni',
  path: '/work/omni-ide',
  displayName: 'omni-ide',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}

function fakeStore(repos: Repo[] = [omni]) {
  const attached: Record<string, FolderWorkspaceAttachedRepo[]> = {}
  return {
    attached,
    getFolderWorkspace: (id: string) => (id === folder.id ? folder : undefined),
    getRepos: () => repos,
    getFolderWorkspaceAttachedRepos: (id: string) => [...(attached[id] ?? [])],
    attachRepoToFolderWorkspace: (id: string, attachment: FolderWorkspaceAttachedRepo) => {
      if (id !== folder.id) {
        return null
      }
      const list = attached[id] ?? []
      if (!list.some((entry) => entry.key === attachment.key)) {
        attached[id] = [...list, attachment]
      }
      return [...attached[id]]
    }
  }
}

describe('attachRepoOnFolderWorktreeCreate', () => {
  it('attaches the repo once when a folder workspace parented the create', () => {
    const store = fakeStore()
    expect(attachRepoOnFolderWorktreeCreate(store, 'folder:ops', omni)).toBe(true)
    expect(attachRepoOnFolderWorktreeCreate(store, 'folder:ops', omni)).toBe(false)
    expect(store.attached.ops).toHaveLength(1)
    expect(store.attached.ops[0].source).toBe('first-worktree')
  })

  it('never attaches for a worktree parent or a folder-kind repo', () => {
    const store = fakeStore()
    expect(attachRepoOnFolderWorktreeCreate(store, 'worktree:repo::/x', omni)).toBe(false)
    expect(attachRepoOnFolderWorktreeCreate(store, 'folder:ops', { ...omni, kind: 'folder' })).toBe(
      false
    )
    expect(store.attached.ops).toBeUndefined()
  })
})

describe('resolveFolderWorkspaceRepoForCreate', () => {
  it('explains how to attach when none is attached and no --repo was given', () => {
    expect(resolveFolderWorkspaceRepoForCreate(fakeStore(), 'folder:ops', undefined)).toMatchObject(
      {
        kind: 'error'
      }
    )
  })

  it('lets an unattached --repo name fall through to the global lookup', () => {
    expect(resolveFolderWorkspaceRepoForCreate(fakeStore(), 'folder:ops', 'omni-ide')).toEqual({
      kind: 'fallthrough'
    })
  })

  it('resolves through the attachment to the registered repo id', () => {
    const store = fakeStore()
    attachRepoOnFolderWorktreeCreate(store, 'folder:ops', omni)
    expect(resolveFolderWorkspaceRepoForCreate(store, 'folder:ops', undefined)).toEqual({
      kind: 'resolved',
      repoSelector: 'id:repo-omni',
      displayName: 'omni-ide'
    })
    expect(resolveFolderWorkspaceRepoForCreate(store, 'folder:ops', 'OMNI-IDE')).toMatchObject({
      kind: 'resolved'
    })
  })

  it('prefers the attached repo the command runs inside (review F4)', () => {
    const other: Repo = { ...omni, id: 'repo-other', path: '/work/other', displayName: 'other' }
    const store = fakeStore([omni, other])
    attachRepoOnFolderWorktreeCreate(store, 'folder:ops', omni)
    attachRepoOnFolderWorktreeCreate(store, 'folder:ops', other)
    expect(
      resolveFolderWorkspaceRepoForCreate(store, 'folder:ops', undefined, 'repo-other')
    ).toMatchObject({ kind: 'resolved', repoSelector: 'id:repo-other' })
    expect(
      resolveFolderWorkspaceRepoForCreate(store, 'folder:ops', undefined, 'not-attached')
    ).toMatchObject({ kind: 'error' })
  })

  it('falls through for a worktree key or unknown folder', () => {
    expect(resolveFolderWorkspaceRepoForCreate(fakeStore(), 'folder:gone', undefined)).toEqual({
      kind: 'fallthrough'
    })
  })
})

describe('resolveFolderWorkspaceJobRepo', () => {
  const remoteRepo: Repo = {
    ...omni,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/omnirogue/omni-ide',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/omnirogue/omni-ide.git'
    }
  }

  it('returns the attached repo whose identity is the job repository', () => {
    const store = fakeStore([remoteRepo])
    attachRepoOnFolderWorktreeCreate(store, 'folder:ops', remoteRepo)
    expect(resolveFolderWorkspaceJobRepo(store, 'ops', 'github.com/omnirogue/omni-ide')?.id).toBe(
      'repo-omni'
    )
  })

  it('returns null when that repository is not attached to the folder', () => {
    const store = fakeStore([remoteRepo])
    expect(
      resolveFolderWorkspaceJobRepo(store, 'ops', 'github.com/omnirogue/omni-ide')
    ).toBeNull()
    attachRepoOnFolderWorktreeCreate(store, 'folder:ops', remoteRepo)
    expect(resolveFolderWorkspaceJobRepo(store, 'ops', 'github.com/other/repo')).toBeNull()
  })
})
