import { beforeEach, describe, expect, it, vi } from 'vitest'

const { probe, stat, readFile } = vi.hoisted(() => ({
  probe: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn()
}))
vi.mock('./git/worktree-metadata-service', () => ({ probeWorktreeMetadata: probe }))
vi.mock('node:fs/promises', () => ({ stat, readFile }))

import {
  localWorktreePathExistsOrIsUnverifiable,
  localWorktreePathsExistOrAreUnverifiable
} from './local-worktree-path-presence'

describe('isolated local worktree presence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves unavailable paths and recognizes both confirmed absence codes without parent filesystem calls', async () => {
    probe.mockResolvedValue(
      new Map([
        ['/present', { operation: 'exists', value: true }],
        ['/missing', { operation: 'exists', value: false, code: 'ENOENT' }],
        ['/not-directory', { operation: 'exists', value: false, code: 'ENOTDIR' }],
        ['/unavailable', undefined]
      ])
    )
    const paths = ['/present', '/missing', '/not-directory', '/unavailable']
    const signal = new AbortController().signal
    expect(await localWorktreePathsExistOrAreUnverifiable(paths, { signal })).toEqual(
      new Map([
        ['/present', true],
        ['/missing', false],
        ['/not-directory', false],
        ['/unavailable', true]
      ])
    )
    expect(probe).toHaveBeenCalledWith('exists', paths, signal)
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('uses the same conservative behavior for a single path and an empty batch', async () => {
    probe.mockResolvedValue(new Map([['/unavailable', undefined]]))
    expect(await localWorktreePathExistsOrIsUnverifiable('/unavailable')).toBe(true)
    probe.mockResolvedValue(
      new Map([['/missing', { operation: 'exists', value: false, code: 'ENOENT' }]])
    )
    expect(await localWorktreePathExistsOrIsUnverifiable('/missing')).toBe(false)
    probe.mockResolvedValue(new Map())
    expect(await localWorktreePathsExistOrAreUnverifiable([])).toEqual(new Map())
  })
})
