import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listRegisteredPtys, nativeGates, nativeProvider } = vi.hoisted(() => ({
  listRegisteredPtys: vi.fn(),
  nativeGates: new Set<string>(),
  nativeProvider: { shutdown: vi.fn(), listProcesses: vi.fn() }
}))

vi.mock('../memory/pty-registry', () => ({ listRegisteredPtys }))
vi.mock('../providers/local-pty-provider-state', () => ({ ptyLaunchGates: nativeGates }))
vi.mock('../ipc/pty/provider/registry', () => ({
  getNativeLocalPtyProvider: () => nativeProvider
}))

import type { IPtyProvider } from '../providers/types'
import { killAllProcessesForWorktree } from './worktree-teardown'

function daemonProvider(): IPtyProvider {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    listProcesses: vi.fn().mockResolvedValue([])
  } as unknown as IPtyProvider
}

beforeEach(() => {
  nativeGates.clear()
  listRegisteredPtys
    .mockReset()
    .mockReturnValue([
      { ptyId: 'native-1', worktreeId: 'w1', sessionId: null, paneKey: null, pid: 100 }
    ])
  nativeProvider.shutdown.mockReset().mockResolvedValue(undefined)
  nativeProvider.listProcesses.mockReset().mockResolvedValue([])
})

describe('native launch gate ownership during workspace teardown', () => {
  it('stops a registry-only native gate through its owner beside a healthy daemon', async () => {
    const localProvider = daemonProvider()
    nativeGates.add('native-1')

    const result = await killAllProcessesForWorktree('w1', { localProvider })

    expect(result.registryStopped).toBe(1)
    expect(nativeProvider.shutdown).toHaveBeenCalledWith(
      'native-1',
      expect.objectContaining({ immediate: true })
    )
    expect(localProvider.shutdown).not.toHaveBeenCalled()
  })

  it('keeps an arbitrary local registry id on its supplied provider', async () => {
    const localProvider = daemonProvider()

    await killAllProcessesForWorktree('w1', { localProvider })

    expect(localProvider.shutdown).toHaveBeenCalledWith(
      'native-1',
      expect.objectContaining({ immediate: true })
    )
    expect(nativeProvider.shutdown).not.toHaveBeenCalled()
  })

  it('does not treat an empty daemon inventory as proof a failed native stop exited', async () => {
    const localProvider = daemonProvider()
    const onPtyStopped = vi.fn()
    nativeGates.add('native-1')
    nativeProvider.shutdown.mockRejectedValue(new Error('native process did not exit'))
    nativeProvider.listProcesses.mockResolvedValue([{ id: 'native-1', cwd: '/w1', title: 'agent' }])

    await expect(
      killAllProcessesForWorktree('w1', {
        localProvider,
        onPtyStopped,
        requirePhysicalStop: true
      })
    ).rejects.toThrow('native-1')

    expect(nativeProvider.listProcesses).toHaveBeenCalledTimes(1)
    expect(onPtyStopped).not.toHaveBeenCalled()
  })

  it('accepts the native owner proving a failed stop already exited', async () => {
    const localProvider = daemonProvider()
    const onPtyStopped = vi.fn()
    nativeGates.add('native-1')
    nativeProvider.shutdown.mockRejectedValue(new Error('already exited'))

    await expect(
      killAllProcessesForWorktree('w1', {
        localProvider,
        onPtyStopped,
        requirePhysicalStop: true
      })
    ).resolves.toMatchObject({ registryStopped: 0 })

    expect(nativeProvider.listProcesses).toHaveBeenCalledTimes(1)
    expect(onPtyStopped).toHaveBeenCalledWith('native-1')
  })

  it('does not redirect an SSH-owned session with a matching native gate id', async () => {
    const sshProvider = daemonProvider()
    vi.mocked(sshProvider.listProcesses).mockResolvedValue([
      { id: 'native-1', worktreeId: 'w1', cwd: '/w1', title: 'remote agent' }
    ])
    nativeGates.add('native-1')

    await killAllProcessesForWorktree('w1', {
      localProvider: sshProvider,
      resolvedConnectionId: 'ssh-1',
      includeLocalRegistry: false,
      requirePhysicalStop: true
    })

    expect(sshProvider.shutdown).toHaveBeenCalledWith(
      'native-1',
      expect.objectContaining({ immediate: true })
    )
    expect(nativeProvider.shutdown).not.toHaveBeenCalled()
    expect(nativeProvider.listProcesses).not.toHaveBeenCalled()
    expect(listRegisteredPtys).not.toHaveBeenCalled()
  })
})
