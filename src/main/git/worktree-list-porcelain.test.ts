import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeMetadataOperation } from './worktree-metadata-protocol'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock,
  probeWorktreeMetadataMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn(),
  probeWorktreeMetadataMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('./status', () => ({
  resolveGitDir: resolveGitDirMock,
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('./worktree-metadata-service', () => ({
  probeWorktreeMetadata: probeWorktreeMetadataMock
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})

import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { listWorktrees, WORKTREE_LIST_TIMEOUT_MS } from './worktree'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState({
    moveWorktreeDirectoryToTrashMock,
    restoreWorktreeDirectoryFromTrashMock,
    scheduleWorktreeTrashDeletionMock
  })
})

describe('listWorktrees', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
    probeWorktreeMetadataMock
      .mockReset()
      .mockImplementation(
        async (operation: WorktreeMetadataOperation, paths: readonly string[]) =>
          new Map(paths.map((path) => [path, { operation, value: false, code: 'ENOENT' }]))
      )
  })

  it('translates parsed path fields from line-block porcelain output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
        'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\nsparse\n\n'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )

    const worktrees = await listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    expect(worktrees).toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
    expect(probeWorktreeMetadataMock).toHaveBeenCalledWith(
      'sparse',
      [expect.stringContaining('repo')],
      undefined
    )
    expect(probeWorktreeMetadataMock.mock.calls[0][1]).toEqual([worktrees[0].path])
    expect(statMock).not.toHaveBeenCalled()
    expect(translateWslOutputPathsMock).toHaveBeenCalledTimes(2)
  })

  it('passes the selected WSL distro when translating Windows-path worktree output', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout:
        'worktree /mnt/c/Users/me/repo\nHEAD abc123\nbranch refs/heads/main\nsparse\n\n' +
        'worktree /mnt/c/Users/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\nsparse\n\n'
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output
        .replace('/mnt/c/Users/me/repo-feature', 'C:\\Users\\me\\repo-feature')
        .replace('/mnt/c/Users/me/repo', 'C:\\Users\\me\\repo')
    )

    await expect(listWorktrees('C:\\Users\\me\\repo', { wslDistro: 'Ubuntu' })).resolves.toEqual([
      {
        path: 'C:\\Users\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isSparse: true,
        isMainWorktree: true
      },
      {
        path: 'C:\\Users\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: 'C:\\Users\\me\\repo',
      wslDistro: 'Ubuntu',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(translateWslOutputPathsMock).toHaveBeenCalledWith(
      expect.any(String),
      'C:\\Users\\me\\repo',
      { wslDistro: 'Ubuntu' }
    )
  })

  it('returns no worktrees when the repo path is gone', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn git ENOENT'), {
        code: 'ENOENT'
      })
    )
    statMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(listWorktrees('/workspace/deleted-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/workspace/deleted-repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(statMock).toHaveBeenCalledWith('/workspace/deleted-repo')
    expect(warnSpy).toHaveBeenCalledWith(
      '[git/worktree] repo path missing; skipping worktree list: /workspace/deleted-repo'
    )
    warnSpy.mockRestore()
  })

  it('returns no worktrees when the path exists but is not a git repo', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: git worktree list --porcelain'), {
        code: 128,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n'
      })
    )

    await expect(listWorktrees('/private/tmp/omni-issue-1582-test/my-repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/private/tmp/omni-issue-1582-test/my-repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('detects sparse checkout after translating paths when porcelain omits sparse token', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args.join(' ') === 'worktree list --porcelain -z') {
        return {
          stdout:
            'worktree /home/me/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
            'worktree /home/me/repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n',
          stderr: ''
        }
      }
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    })
    translateWslOutputPathsMock.mockImplementation((output: string) =>
      output.replace('/home/me/', '\\\\wsl.localhost\\Ubuntu\\home\\me\\')
    )
    const featureWorktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature'
    probeWorktreeMetadataMock.mockImplementation(
      async (operation: WorktreeMetadataOperation, paths: readonly string[]) =>
        new Map(paths.map((path) => [path, { operation, value: path === featureWorktreePath }]))
    )

    const worktrees = await listWorktrees('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')

    expect(worktrees).toEqual([
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isSparse: true,
        isMainWorktree: false
      }
    ])
    expect(probeWorktreeMetadataMock).toHaveBeenCalledWith(
      'sparse',
      worktrees.map((worktree) => worktree.path),
      undefined
    )
    expect(resolveGitDirMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(getGitCalls()).toEqual(['git worktree list --porcelain -z'])
  })

  it('batches translated sparse hints and preserves rows with unknown metadata', async () => {
    const worktreeCount = 20
    const sparseWorktreePath = '/repo-worktree-17'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: Array.from({ length: worktreeCount }, (_, index) =>
        [
          `worktree ${index === 0 ? '/repo' : `/repo-worktree-${index}`}`,
          `HEAD ${String(index).padStart(6, '0')}`,
          `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
          ''
        ].join('\n')
      ).join('\n'),
      stderr: ''
    })

    probeWorktreeMetadataMock.mockResolvedValueOnce(
      new Map([[sparseWorktreePath, { operation: 'sparse', value: true }]])
    )
    const worktrees = await listWorktrees('/repo')

    expect(probeWorktreeMetadataMock).toHaveBeenCalledExactlyOnceWith(
      'sparse',
      worktrees.map((worktree) => worktree.path),
      undefined
    )
    expect(statMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(worktrees).toHaveLength(worktreeCount)
    expect(worktrees[0].isSparse).toBeUndefined()
    expect(worktrees[17]).toMatchObject({
      path: sparseWorktreePath,
      isSparse: true
    })
  })

  it('falls back to line-block porcelain output when Git rejects -z', async () => {
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
      }
    })
    probeWorktreeMetadataMock.mockImplementation(
      async (operation: WorktreeMetadataOperation, paths: readonly string[]) =>
        new Map(paths.map((path) => [path, { operation, value: operation === 'exists' }]))
    )

    await expect(listWorktrees('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      }
    ])
    expect(getGitCalls()).toEqual([
      'git worktree list --porcelain -z',
      'git worktree list --porcelain'
    ])
  })

  it('annotates missing linked worktrees as prunable via the line-block fallback', async () => {
    // Why: Git <2.36 lacks the `prunable` porcelain field (issue #8389), so
    // the fallback must probe each linked worktree path instead of treating a
    // stale registration as a live workspace.
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n' +
          'worktree /repo-locked\nHEAD aaa789\nbranch refs/heads/agent\nlocked agent session\n'
      }
    })
    // The isolated existence result confirms ENOENT; sparse hints remain false.

    const worktrees = await listWorktrees('/repo')

    expect(worktrees.find((worktree) => worktree.path === '/repo-feature')).toMatchObject({
      prunable: true
    })
    // Locked registrations are shielded, mirroring git's own prunable rules;
    // the main worktree is covered by the repo-level missing-path handling.
    expect(worktrees.find((worktree) => worktree.path === '/repo-locked')?.prunable).toBeUndefined()
    expect(worktrees.find((worktree) => worktree.path === '/repo')?.prunable).toBeUndefined()
  })
})
