import { beforeEach, describe, expect, it, vi } from 'vitest'

const { probe, stat, readFile, git, sparsePaths } = vi.hoisted(() => ({
  probe: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  git: vi.fn(),
  sparsePaths: new Set<string>()
}))
vi.mock('node:fs/promises', () => ({ stat, readFile, realpath: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: git,
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./git-capability-state', () => ({
  withLocalGitCapabilityCacheForExecution: (
    _scope: unknown,
    run: (capabilities: object) => unknown
  ) =>
    run({
      runWithFallback: (_name: string, _preferred: unknown, fallback: () => unknown) => fallback()
    })
}))
vi.mock('./worktree-metadata-service', () => ({ probeWorktreeMetadata: probe }))

import { listWorktreesStrict, listWorktreesUnshared } from './worktree-listing'
import { readWorktreeList } from './worktree-list-reader'

const paths = [
  '/repo',
  '/repo/sparse',
  '/repo/missing',
  '/repo/not-directory',
  '/repo/unavailable',
  '/repo/locked'
]
const listing = paths
  .map(
    (path, index) =>
      `worktree ${path}\nHEAD abc123\nbranch refs/heads/branch-${index}\n${path.endsWith('/locked') ? 'locked\n' : ''}`
  )
  .join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  sparsePaths.clear()
  git.mockResolvedValue({ stdout: listing })
  probe.mockImplementation(
    async (operation: string, candidates: string[]) =>
      new Map(
        candidates.map((path) => {
          if (operation === 'sparse') {
            return [
              path,
              path.endsWith('/unavailable')
                ? undefined
                : { operation, value: sparsePaths.has(path) }
            ]
          }
          if (path.endsWith('/missing')) {
            return [path, { operation, value: false, code: 'ENOENT' }]
          }
          if (path.endsWith('/not-directory')) {
            return [path, { operation, value: false, code: 'ENOTDIR' }]
          }
          return [path, path.endsWith('/unavailable') ? undefined : { operation, value: true }]
        })
      )
  )
})

describe('worktree listing with isolated metadata', () => {
  it.each([
    ['strict', listWorktreesStrict],
    ['lenient', listWorktreesUnshared]
  ] as const)('preserves the complete Git list without parent reads (%s)', async (_name, list) => {
    sparsePaths.add('/repo/sparse')
    const signal = new AbortController().signal
    const results = await list('/repo', { signal })
    expect(results.map((result) => result.path)).toEqual(paths)
    expect(results.find((result) => result.path === '/repo/sparse')?.isSparse).toBe(true)
    expect(results.find((result) => result.path === '/repo/unavailable')?.isSparse).toBeUndefined()
    expect(probe).toHaveBeenCalledWith('sparse', paths, signal)
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('keeps Git 2.25 fallback absence semantics and never probes locked or main worktrees', async () => {
    const results = await readWorktreeList('/repo')
    expect(results.filter((result) => result.prunable).map((result) => result.path)).toEqual([
      '/repo/missing'
    ])
    expect(probe).toHaveBeenCalledWith('exists', paths.slice(1, -1), undefined)
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})
