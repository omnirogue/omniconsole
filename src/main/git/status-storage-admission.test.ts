import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'
import type * as LineStatsCache from '../../shared/git-status-line-stats-cache'
import { getStatus } from './source-control/status-read'
import { getDiff } from './source-control/file-diff'
import {
  invalidateGitReadCaches,
  settledDiffCache
} from './source-control/git-read-cache-invalidation'

const { admission, conflict, stream, stamp, beginStats } = vi.hoisted(() => ({
  admission: vi.fn(),
  conflict: vi.fn(),
  stream: vi.fn(),
  stamp: vi.fn(),
  beginStats: vi.fn()
}))
vi.mock('../local-worktree-read-admission', () => ({ assertLocalWorktreeReadable: admission }))
vi.mock('./source-control/git-conflict-operation', () => ({ detectConflictOperation: conflict }))
vi.mock('./source-control/worktree-diff-stamp', () => ({ readWorktreeDiffStamp: stamp }))
vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitStreamStdout: stream
}))
vi.mock('../../shared/git-status-line-stats-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof LineStatsCache>()),
  beginGitStatusLineStatsCacheWrite: beginStats
}))

beforeEach(() => {
  vi.clearAllMocks()
  invalidateGitReadCaches()
})

describe('native Git read storage admission', () => {
  it('coalesces status before probing and rejects before conflict, Git or cache writes', async () => {
    const error = new Error('storage admission denied')
    admission.mockRejectedValue(error)
    const results = await Promise.allSettled([getStatus('/repo'), getStatus('/repo')])
    expect(results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error }
    ])
    expect(admission).toHaveBeenCalledTimes(1)
    expect(conflict).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(beginStats).not.toHaveBeenCalled()
  })

  it('cancels the shared admission when the last status caller aborts', async () => {
    admission.mockImplementation(
      (_path, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const controller = new AbortController()
    const pending = getStatus('/repo', { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(conflict).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(beginStats).not.toHaveBeenCalled()
  })

  it('rejects a diff before stamp reads, generations or cached content can change', async () => {
    const error = new Error('storage admission denied')
    admission.mockRejectedValue(error)
    const begin = vi.spyOn(settledDiffCache, 'beginRead')
    const set = vi.spyOn(settledDiffCache, 'set')
    try {
      await expect(getDiff('/repo', 'file.txt', false)).rejects.toBe(error)
      expect(stamp).not.toHaveBeenCalled()
      expect(begin).not.toHaveBeenCalled()
      expect(set).not.toHaveBeenCalled()
    } finally {
      begin.mockRestore()
      set.mockRestore()
    }
  })
})
