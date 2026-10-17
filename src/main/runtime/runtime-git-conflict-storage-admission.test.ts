import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeGitStatusCommands } from './runtime-git-status-commands'

const { admission, conflict, provider } = vi.hoisted(() => ({
  admission: vi.fn(),
  conflict: vi.fn(),
  provider: vi.fn()
}))
vi.mock('../local-worktree-read-admission', () => ({ assertLocalWorktreeReadable: admission }))
vi.mock('../git/status', () => ({ detectConflictOperation: conflict }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: provider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH unavailable'
}))

beforeEach(() => {
  vi.resetAllMocks()
})

describe('standalone conflict storage admission', () => {
  function commands(connectionId?: string) {
    return new RuntimeGitStatusCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: { path: '/repo' }, connectionId })
    } as never)
  }

  it('propagates local rejection before conflict marker reads and admits a later fresh check', async () => {
    const error = new Error('storage admission denied')
    admission.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)
    conflict.mockResolvedValue('none')
    await expect(commands().getRuntimeGitConflictOperation('id:wt')).rejects.toBe(error)
    expect(conflict).not.toHaveBeenCalled()
    await expect(commands().getRuntimeGitConflictOperation('id:wt')).resolves.toBe('none')
    expect(admission).toHaveBeenCalledTimes(2)
    expect(conflict).toHaveBeenCalledOnce()
  })

  it('leaves remote reads with the SSH owner and never falls back locally', async () => {
    const remoteConflict = vi.fn().mockResolvedValue('merge')
    provider
      .mockReturnValueOnce({ detectConflictOperation: remoteConflict })
      .mockReturnValueOnce(null)
    await expect(commands('ssh-1').getRuntimeGitConflictOperation('id:wt')).resolves.toBe('merge')
    await expect(commands('ssh-1').getRuntimeGitConflictOperation('id:wt')).rejects.toThrow(
      'SSH unavailable'
    )
    expect(remoteConflict).toHaveBeenCalledWith('/repo')
    expect(admission).not.toHaveBeenCalled()
    expect(conflict).not.toHaveBeenCalled()
  })
})
