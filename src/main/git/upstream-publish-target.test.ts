import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../shared/git-partial-clone-cache', () => ({
  gitPartialCloneCache: { get: vi.fn().mockResolvedValue(false) },
  invalidateGitPartialCloneConfig: vi.fn()
}))

import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

describe('getUpstreamStatus', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitUpstreamStatusReads()
  })

  it('uses an explicit publish target instead of the configured upstream', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '1\t2\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n', stderr: '' })

    const result = await getUpstreamStatus('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 1,
      behind: 2,
      behindCommitsArePatchEquivalent: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['check-ref-format', '--branch', 'feature/fix'],
        { cwd: '/repo', signal: expect.any(AbortSignal), timeout: 5000 }
      ],
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'],
        { cwd: '/repo', signal: expect.any(AbortSignal), timeout: 5000 }
      ],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        { cwd: '/repo', signal: expect.any(AbortSignal), timeout: 5000 }
      ],
      [
        [
          'log',
          '--oneline',
          '--cherry-mark',
          '--right-only',
          'HEAD...refs/remotes/fork/feature/fix',
          '--'
        ],
        { cwd: '/repo', signal: expect.any(AbortSignal), timeout: 5000 }
      ]
    ])
  })

  it('routes explicit publish-target probes through the selected WSL distro', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '0\t0\n', stderr: '' })

    await expect(
      getUpstreamStatus(
        '/repo',
        {
          remoteName: 'fork',
          branchName: 'feature/fix'
        },
        { wslDistro: 'Ubuntu' }
      )
    ).resolves.toEqual({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['check-ref-format', '--branch', 'feature/fix'],
        {
          cwd: '/repo',
          wslDistro: 'Ubuntu',
          signal: expect.any(AbortSignal),
          timeout: 5000
        }
      ],
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'],
        {
          cwd: '/repo',
          wslDistro: 'Ubuntu',
          signal: expect.any(AbortSignal),
          timeout: 5000
        }
      ],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        {
          cwd: '/repo',
          wslDistro: 'Ubuntu',
          signal: expect.any(AbortSignal),
          timeout: 5000
        }
      ]
    ])
  })

  it('reports no upstream when an explicit publish target has not been fetched yet', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('git exited with 1.'), { stderr: '' }))

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).resolves.toEqual({
      hasUpstream: false,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not hide git failures while checking an explicit publish target', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(
      Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository'
      })
    )

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).rejects.toThrow('fatal: not a git repository')
  })
})
