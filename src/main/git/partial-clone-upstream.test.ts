import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GitPartialCloneCache,
  clearGitPartialCloneStateForTests
} from '../../shared/git-partial-clone-cache'
import { GitHandlerComparisonOperations } from '../../relay/git-handler-comparison-operations'
import type { GitHandlerOperationHost } from '../../relay/git-handler-operation-context'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: exec }))
import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

const configArgs = ['config', '--local', '--null', '--list']
const logArgs = ['log', '--oneline', '--cherry-mark', '--right-only', 'HEAD...origin/main', '--']
function fixture(config: string) {
  return (args: string[]) => {
    const stdout =
      args[0] === 'config'
        ? config
        : args[0] === 'symbolic-ref'
          ? 'main\n'
          : args[0] === 'rev-parse'
            ? 'origin/main\n'
            : args[0] === 'rev-list'
              ? '2\t3\n'
              : args[0] === 'log'
                ? '= abc subject\n'
                : ''
    return Promise.resolve({ stdout, stderr: '' })
  }
}

beforeEach(() => {
  exec.mockReset()
  invalidateGitUpstreamStatusReads()
})
afterEach(() => {
  vi.useRealTimers()
  clearGitPartialCloneStateForTests()
})

describe('partial clone upstream reads', () => {
  it.each([
    'remote.origin.promisor\ntrue\0',
    'remote.fork.partialclonefilter\nblob:none\0',
    'remote.fork.promisor\n2\0',
    'remote.fork.promisor\0'
  ])('skips patch IDs for %s while preserving counts and caching config', async (config) => {
    exec.mockImplementation(fixture(config))
    for (let i = 0; i < 2; i++) {
      await expect(getUpstreamStatus('/repo')).resolves.toEqual({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 2,
        behind: 3,
        patchEquivalenceUnknown: true
      })
    }
    expect(exec.mock.calls.some(([args]) => args.includes('--cherry-mark'))).toBe(false)
    expect(exec).toHaveBeenCalledWith(
      ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
      expect.anything()
    )
    expect(exec.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(1)
    invalidateGitUpstreamStatusReads()
    await getUpstreamStatus('/repo')
    expect(exec.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(2)
  })

  it('preserves full clone patch-ID argv and result', async () => {
    exec.mockImplementation(fixture('remote.origin.promisor\nfalse\0'))
    await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({
      behindCommitsArePatchEquivalent: true
    })
    expect(exec).toHaveBeenCalledWith(logArgs, expect.anything())
  })

  it('isolates repository paths and WSL distros', async () => {
    exec.mockImplementation(fixture(''))
    for (const [path, distro] of [
      ['/a', undefined],
      ['/b', undefined],
      ['/a', 'Ubuntu'],
      ['/a', 'Debian']
    ]) {
      await getUpstreamStatus(path!, undefined, { wslDistro: distro })
    }
    expect(exec.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(4)
  })

  it('aborts a hung read at five seconds and releases its owner for a retry', async () => {
    vi.useFakeTimers()
    const aborted = vi.fn()
    exec.mockImplementation(
      (_args, options) =>
        new Promise((_resolve, reject) => {
          expect(options.timeout).toBe(5000)
          if (options.signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          options.signal.addEventListener(
            'abort',
            () => {
              aborted()
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            },
            { once: true }
          )
        })
    )
    const first = getUpstreamStatus('/repo')
    const joined = getUpstreamStatus('/repo')
    await vi.advanceTimersByTimeAsync(5000)
    await expect(first).resolves.toMatchObject({ upstreamStatusUnknown: true })
    await expect(joined).resolves.toMatchObject({ upstreamStatusUnknown: true })
    expect(aborted).toHaveBeenCalledOnce()
    exec.mockImplementation(fixture(''))
    await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({ ahead: 2, behind: 3 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('guards the relay twin on the execution host', async () => {
    const git = vi.fn(fixture('remote.origin.promisor\ntrue\0'))
    const relay = new GitHandlerComparisonOperations({ git } as unknown as GitHandlerOperationHost)
    await expect(relay.upstreamStatus({ worktreePath: '/remote' })).resolves.toMatchObject({
      ahead: 2,
      behind: 3,
      patchEquivalenceUnknown: true
    })
    expect(git.mock.calls.some(([args]) => args.includes('--cherry-mark'))).toBe(false)
    expect(git).toHaveBeenCalledWith(
      configArgs,
      '/remote',
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('coalesces probes and refuses stale publication after invalidation', async () => {
    const cache = new GitPartialCloneCache()
    let resolve!: (value: { stdout: string }) => void
    const run = vi.fn(
      () =>
        new Promise<{ stdout: string }>((done) => {
          resolve = done
        })
    )
    const first = cache.get('/repo', run)
    const joined = cache.get('/repo', run)
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    cache.clear()
    const fresh = vi.fn().mockResolvedValue({ stdout: 'remote.origin.promisor\ntrue\0' })
    expect(await cache.get('/repo', fresh)).toBe(true)
    resolve({ stdout: '' })
    expect(await first).toBe(false)
    expect(await joined).toBe(false)
    expect(await cache.get('/repo', fresh)).toBe(true)
    expect(fresh).toHaveBeenCalledOnce()
  })
  it('preserves full-clone argv on the relay', async () => {
    const git = vi.fn(fixture(''))
    const relay = new GitHandlerComparisonOperations({ git } as unknown as GitHandlerOperationHost)
    await expect(relay.upstreamStatus({ worktreePath: '/remote' })).resolves.toMatchObject({
      ahead: 2,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
    expect(git).toHaveBeenCalledWith(logArgs, '/remote', expect.objectContaining({ timeout: 5000 }))
  })

  it('does not cache failed config reads or run patch IDs without a known full clone', async () => {
    exec.mockImplementation((args) =>
      args[0] === 'config' ? Promise.reject(new Error('unavailable')) : fixture('')(args)
    )
    await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({
      patchEquivalenceUnknown: true
    })
    expect(exec.mock.calls.some(([args]) => args.includes('--cherry-mark'))).toBe(false)
    exec.mockImplementation(fixture(''))
    await expect(getUpstreamStatus('/repo')).resolves.toMatchObject({
      behindCommitsArePatchEquivalent: true
    })
    expect(exec.mock.calls.filter(([args]) => args[0] === 'config')).toHaveLength(2)
  })
})
