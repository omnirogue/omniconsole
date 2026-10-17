import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleepWorkspace } from '../../shared/artifact-review-sleep'

const gitCalls: string[][] = []
const git = vi.hoisted(() => ({
  config: {} as Record<string, string>,
  remoteHead: 'abc',
  defaultBranch: 'main',
  currentBranch: 'feat' as string | null,
  localBranchLeft: false,
  pushedHere: true,
  open: { from: 0, into: 0 } as { from: number; into: number } | null | 'throw'
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async (args: string[]) => {
    gitCalls.push(args)
    const joined = args.join(' ')
    const out = (stdout: string) => ({ stdout: `${stdout}\n`, stderr: '' })
    if (args[0] === 'config') {
      const value = git.config[args[2]!]
      if (value === undefined) {
        throw new Error('missing')
      }
      return out(value)
    }
    if (joined === 'symbolic-ref --quiet --short HEAD') {
      if (!git.currentBranch) {
        throw Object.assign(new Error('not a branch'), { code: git.currentBranch === '' ? 1 : 128 })
      }
      return out(git.currentBranch)
    }
    if (joined === 'symbolic-ref --quiet refs/remotes/origin/HEAD') {
      return out(`refs/remotes/origin/${git.defaultBranch}`)
    }
    if (joined === 'rev-parse --git-common-dir') {
      return out('/repo/.git')
    }
    if (args[0] === 'rev-parse') {
      return out('abc')
    }
    if (args[0] === 'ls-remote') {
      return out(git.remoteHead ? `${git.remoteHead}\trefs/heads/x` : '')
    }
    if (args[0] === 'show-ref') {
      if (git.localBranchLeft) {
        return out('abc refs/heads/feat')
      }
      throw Object.assign(new Error('gone'), { code: 1 })
    }
    if (args[0] === 'reflog') {
      return out(
        git.pushedHere ? 'fetch: fast-forward\nupdate by push' : 'fetch origin: storing head'
      )
    }
    return out('')
  })
}))
vi.mock('../github/github-open-pull-requests-for-branch', () => ({
  openGitHubPullRequestsTouching: vi.fn(async () => {
    if (git.open === 'throw') {
      throw new Error('rate limited')
    }
    return git.open
  })
}))

const { purgeSessionWorkspace } = await import('./artifact-review-workspace-purge')

function runtime() {
  return {
    removeManagedWorktree: vi.fn(async () => ({
      preservedBranch: { branchName: 'feat', head: 'abc' }
    })),
    forceDeletePreservedBranch: vi.fn(async () => ({ deleted: true as const }))
  }
}

const OWN = {
  kind: 'git' as const,
  path: '/repo-wt',
  branch: 'feat',
  createdForSession: true,
  worktreeId: 'r::/repo-wt',
  createdBranch: 'feat'
}
const input = (workspace: ArtifactReviewSleepWorkspace = OWN, shared = false) => ({
  worktreeId: 'r::/repo-wt',
  workspace,
  sharedWithAnotherSession: shared
})

describe('workspace purge on reject', () => {
  beforeEach(() => {
    gitCalls.length = 0
    git.config = { 'branch.feat.remote': 'origin', 'branch.feat.merge': 'refs/heads/feat' }
    git.remoteHead = 'abc'
    git.defaultBranch = 'main'
    git.currentBranch = 'feat'
    git.localBranchLeft = false
    git.pushedHere = true
    git.open = { from: 0, into: 0 }
  })

  it('removes the worktree, then the local and the pushed remote branch, from the repository root', async () => {
    const host = runtime()
    const purge = await purgeSessionWorkspace(host, input())
    expect(host.removeManagedWorktree).toHaveBeenCalledWith('id:r::/repo-wt', true, false)
    expect(host.forceDeletePreservedBranch).toHaveBeenCalledWith('id:r::/repo-wt', 'feat', 'abc')
    expect(vi.mocked((await import('../git/runner')).gitExecFileAsync)).toHaveBeenCalledWith(
      ['push', 'origin', '--delete', 'feat'],
      { cwd: '/repo' }
    )
    expect(purge.removed).toEqual([
      'worktree /repo-wt',
      'local branch feat',
      'remote branch origin/feat'
    ])
  })

  it('never deletes the branch it tracks when that is not its own (a base such as main-next)', async () => {
    git.config['branch.feat.merge'] = 'refs/heads/main-next'
    const purge = await purgeSessionWorkspace(runtime(), input())
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false)
    expect(purge.kept.join(' ')).toContain('tracks origin/main-next, not its own')
  })

  it('never deletes the remote default branch, nor one on another remote', async () => {
    git.currentBranch = 'main'
    git.config = { 'branch.main.remote': 'origin', 'branch.main.merge': 'refs/heads/main' }
    const main = await purgeSessionWorkspace(
      runtime(),
      input({ ...OWN, branch: 'main', createdBranch: 'main' })
    )
    expect(main.kept.join(' ')).toContain('it is the default branch')
    git.currentBranch = 'feat'
    git.config = { 'branch.feat.remote': 'fork', 'branch.feat.merge': 'refs/heads/feat' }
    const fork = await purgeSessionWorkspace(runtime(), input())
    expect(fork.kept.join(' ')).toContain('tracks fork/feat')
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false)
  })

  it('keeps the remote branch while a pull request is open from or into it, or that is unknown', async () => {
    git.open = { from: 1, into: 0 }
    expect((await purgeSessionWorkspace(runtime(), input())).kept.join(' ')).toContain(
      'a pull request is open from it'
    )
    git.open = { from: 0, into: 1 }
    expect((await purgeSessionWorkspace(runtime(), input())).kept.join(' ')).toContain(
      'a pull request is open into it'
    )
    git.open = 'throw'
    expect((await purgeSessionWorkspace(runtime(), input())).kept.join(' ')).toContain(
      'could not confirm'
    )
    git.open = null
    expect((await purgeSessionWorkspace(runtime(), input())).kept.join(' ')).toContain(
      'its host cannot say'
    )
    git.open = { from: 0, into: 0 }
    git.remoteHead = 'def'
    expect((await purgeSessionWorkspace(runtime(), input())).kept.join(' ')).toContain(
      'holds commits'
    )
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false)
  })

  it('never deletes a same-name branch this computer only fetched (a shared base checked out by name)', async () => {
    git.pushedHere = false
    git.currentBranch = 'main-next'
    git.config = {
      'branch.main-next.remote': 'origin',
      'branch.main-next.merge': 'refs/heads/main-next'
    }
    const purge = await purgeSessionWorkspace(
      runtime(),
      input({ ...OWN, branch: 'main-next', createdBranch: 'main-next' })
    )
    expect(purge.kept.join(' ')).toContain('did not create it by a push')
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false)
  })

  it('records a local branch git kept instead of claiming it', async () => {
    git.localBranchLeft = true
    const purge = await purgeSessionWorkspace(runtime(), input())
    expect(purge.kept).toContain('local branch feat: git kept it')
  })

  it('never touches folder workspaces, worktrees made elsewhere, moved or shared ones', async () => {
    for (const [workspace, shared] of [
      [{ kind: 'folder' as const, path: '/Users/me/Work/x' }, false],
      [{ ...OWN, createdForSession: false }, false],
      [{ ...OWN, worktreeId: 'r::/other' }, false],
      [OWN, true]
    ] as const) {
      const host = runtime()
      const purge = await purgeSessionWorkspace(host, input(workspace, shared))
      expect(host.removeManagedWorktree).not.toHaveBeenCalled()
      expect(purge.removed).toEqual([])
    }
    expect(gitCalls).toEqual([])
  })

  it('keeps a worktree whole when it is on a branch it did not create, or that is unknown', async () => {
    for (const [workspace, current, said] of [
      [OWN, 'main-next', 'it is on main-next, a branch this session did not create'],
      [
        { ...OWN, createdBranch: undefined },
        'feat',
        'it is on feat, a branch this session did not create'
      ],
      [OWN, null, 'its branch could not be read']
    ] as const) {
      git.currentBranch = current
      const host = runtime()
      const purge = await purgeSessionWorkspace(host, input(workspace))
      expect(host.removeManagedWorktree).not.toHaveBeenCalled()
      expect(purge.kept.join(' ')).toContain(said)
    }
    expect(gitCalls.some((args) => args[0] === 'push')).toBe(false)
  })

  it('removes a detached worktree and deletes no branch', async () => {
    git.currentBranch = ''
    const host = runtime()
    const purge = await purgeSessionWorkspace(host, input())
    expect(host.removeManagedWorktree).toHaveBeenCalled()
    expect(host.forceDeletePreservedBranch).not.toHaveBeenCalled()
    expect(purge.removed).toEqual(['worktree /repo-wt'])
    expect(purge.kept).toContain('branches of /repo-wt: no branch is checked out')
  })
})
