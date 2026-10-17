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

  it('uses a named remote that matches a URL-valued branch remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/omni.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/omni.git\n' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'pr-pynickle-omni') {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/omni.git\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\npr-pynickle-omni\n' })
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('refs/remotes/pr-pynickle-omni/imp/chinese-translation')
      ) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'pr-pynickle-omni/imp/chinese-translation',
      ahead: 2,
      behind: 0
    })
  })

  it('uses a fork head branch even when its name matches the base branch', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '3\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/main',
      ahead: 3,
      behind: 0
    })
  })

  it('marks a URL-valued branch push target when no matching remote is configured', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.pushRemote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/omni.git\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/omni.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/omni.git\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/imp/chinese-translation')) {
        return Promise.reject(new Error('missing origin tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('marks a fork head push target when the same-named base branch is on another remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.pushRemote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.reject(new Error('missing fork tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/review/pr-1')) {
        return Promise.reject(new Error('missing origin review branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not mark origin base-branch config as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
        return Promise.reject(new Error('missing origin/main tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.reject(new Error('missing origin/feature tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('does not mark remote.pushDefault plus origin base branch as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature/fix\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature/fix')) {
        return Promise.reject(new Error('missing origin feature branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('keeps a configured upstream whose remote name contains a slash', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.resolve({ stdout: 'origin/team/feature\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\norigin/team\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.resolve({ stdout: 'origin-feature-oid\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/team/feature')) {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
        return Promise.resolve({ stdout: '9\t9\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/team/feature',
      ahead: 2,
      behind: 0
    })
  })
})
