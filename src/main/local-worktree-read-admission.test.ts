import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertLocalWorktreeReadable,
  WORKTREE_STORAGE_UNAVAILABLE_MESSAGE,
  WORKTREE_STORAGE_HELPER_EXHAUSTED_MESSAGE
} from './local-worktree-read-admission'

const { probe, exhausted } = vi.hoisted(() => ({ probe: vi.fn(), exhausted: vi.fn() }))
vi.mock('./git/worktree-metadata-service', () => ({
  probeWorktreeMetadata: probe,
  areWorktreeMetadataProbesExhausted: exhausted
}))

beforeEach(() => {
  probe.mockReset()
  exhausted.mockReset().mockReturnValue(false)
})

describe('strict local read admission', () => {
  it.each([
    undefined,
    { operation: 'exists', value: true },
    { operation: 'sparse', value: false },
    { operation: 'readable', value: false }
  ])('rejects advisory or unknown results: %j', async (result) => {
    probe.mockResolvedValue(new Map([[resolve('/repo'), result]]))
    await expect(assertLocalWorktreeReadable('/repo')).rejects.toThrow(
      WORKTREE_STORAGE_UNAVAILABLE_MESSAGE
    )
  })

  it('requires a fresh explicit readable result for every call', async () => {
    probe.mockResolvedValueOnce(
      new Map([[resolve('/repo'), { operation: 'readable', value: true }]])
    )
    probe.mockResolvedValueOnce(new Map())
    await expect(assertLocalWorktreeReadable('/repo')).resolves.toBeUndefined()
    await expect(assertLocalWorktreeReadable('/repo')).rejects.toThrow(
      WORKTREE_STORAGE_UNAVAILABLE_MESSAGE
    )
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenLastCalledWith('readable', [resolve('/repo')], undefined)
  })

  it('preserves a caller abort instead of presenting a storage failure', async () => {
    const controller = new AbortController()
    probe.mockImplementation(async () => {
      controller.abort()
      return new Map()
    })
    await expect(assertLocalWorktreeReadable('/repo', controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('explains permanent helper exhaustion without admitting native reads', async () => {
    probe.mockResolvedValue(new Map())
    exhausted.mockReturnValue(true)
    await expect(assertLocalWorktreeReadable('/repo')).rejects.toThrow(
      WORKTREE_STORAGE_HELPER_EXHAUSTED_MESSAGE
    )
  })
})
