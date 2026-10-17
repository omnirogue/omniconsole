import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { buildFolderWorkspaceAttachedRepo } from '../../../shared/folder-workspace-attached-repos'
import { resolveFolderGitTarget } from './folder-workspace-git-target'

const repo: Repo = {
  id: 'repo-1',
  path: '/work/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}
const folder = { id: 'ops', name: 'Ops', folderPath: '/work/ops' } as FolderWorkspace
function wt(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id: `repo-1::/work/${id}`,
    instanceId: `${id}-i`,
    repoId: 'repo-1',
    path: `/work/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0,
    ...extra
  }
}
const main = wt('app', { isMainWorktree: true, path: '/work/app', id: 'repo-1::/work/app' })
const older = wt('older', { lastActivityAt: 1 })
const newer = wt('newer', { lastActivityAt: 5 })
const childOf = (worktree: Worktree) => ({
  [`worktree:${worktree.id}`]: {
    childWorkspaceKey: `worktree:${worktree.id}` as const,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: 'folder:ops' as const,
    origin: 'cli' as const,
    capture: { source: 'env-workspace' as const, confidence: 'explicit' as const },
    createdAt: 1
  }
})

function resolve(overrides: Partial<Parameters<typeof resolveFolderGitTarget>[0]> = {}) {
  return resolveFolderGitTarget({
    activeWorkspaceKey: 'folder:ops',
    activeWorktreeId: 'folder:ops',
    folderWorkspaces: [folder],
    workspaceLineageByChildKey: {},
    worktreeLineageById: {},
    worktreesByRepo: { 'repo-1': [main, older, newer] },
    repos: [repo],
    attachedRepos: [],
    chosenWorktreeId: undefined,
    ...overrides
  })
}

describe('resolveFolderGitTarget', () => {
  it('is not-folder for an ordinary worktree', () => {
    expect(resolve({ activeWorkspaceKey: null, activeWorktreeId: main.id }).kind).toBe('not-folder')
  })

  it('asks to attach a repo when the folder has neither attachments nor session worktrees', () => {
    expect(resolve()).toEqual({ kind: 'needs-attach', folderWorkspaceId: 'ops' })
  })

  it('prefers the most recent session worktree, then the attached repo checkout', () => {
    const target = resolve({
      workspaceLineageByChildKey: { ...childOf(older), ...childOf(newer) },
      attachedRepos: [buildFolderWorkspaceAttachedRepo(repo, 'manual', 1)]
    })
    expect(target.kind === 'target' && target.worktree.id).toBe(newer.id)
    expect(
      target.kind === 'target' && target.candidates.map((c) => [c.worktree.id, c.kind])
    ).toEqual([
      [newer.id, 'session-worktree'],
      [older.id, 'session-worktree'],
      [main.id, 'repo-checkout']
    ])
  })

  it('uses the attached repo checkout when no session worktree exists, and honors a choice', () => {
    const attachedRepos = [buildFolderWorkspaceAttachedRepo(repo, 'manual', 1)]
    const byAttachment = resolve({ attachedRepos })
    expect(byAttachment.kind === 'target' && byAttachment.worktree.id).toBe(main.id)
    const chosen = resolve({
      attachedRepos,
      workspaceLineageByChildKey: childOf(newer),
      chosenWorktreeId: main.id
    })
    expect(chosen.kind === 'target' && chosen.worktree.id).toBe(main.id)
  })

  it('defaults to the most recently active worktree, descendants included (review F2)', () => {
    const parent = wt('parent', { lastActivityAt: 1 })
    const child = wt('child', { lastActivityAt: 10 })
    const target = resolve({
      workspaceLineageByChildKey: childOf(parent),
      worktreeLineageById: {
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId!,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId!,
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        }
      },
      worktreesByRepo: { 'repo-1': [main, parent, child] }
    })
    expect(target.kind === 'target' && target.worktree.id).toBe(child.id)
  })

  it('picks the attached host’s checkout when hosts repeat ids, and keeps both (review F1)', () => {
    const remoteMain = { ...main, hostId: 'ssh:box' } as Worktree
    const remoteRepo: Repo = { ...repo, connectionId: 'box' }
    const target = resolve({
      repos: [remoteRepo],
      worktreesByRepo: { 'repo-1': [main, remoteMain] },
      attachedRepos: [buildFolderWorkspaceAttachedRepo(remoteRepo, 'manual', 1)]
    })
    expect(target.kind === 'target' && target.worktree.hostId).toBe('ssh:box')
  })

  it('says the attached repo is not loaded yet instead of asking to attach (review F3)', () => {
    expect(
      resolve({
        worktreesByRepo: {},
        attachedRepos: [buildFolderWorkspaceAttachedRepo(repo, 'manual', 1)]
      })
    ).toEqual({ kind: 'unavailable', folderWorkspaceId: 'ops', repoNames: ['app'] })
  })

  it('never calls an unknown or failed attachment load "nothing attached" (round 2 F3)', () => {
    expect(resolve({ attachedReposStatus: 'loading' })).toEqual({
      kind: 'attachments-unknown',
      folderWorkspaceId: 'ops',
      failed: false
    })
    expect(resolve({ attachedReposStatus: 'failed' })).toEqual({
      kind: 'attachments-unknown',
      folderWorkspaceId: 'ops',
      failed: true
    })
    expect(resolve({ attachedReposStatus: 'ready' }).kind).toBe('needs-attach')
  })
})
