import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDaemonWrapperForeground } from './daemon-wrapper-foreground'

const { resolveForeground } = vi.hoisted(() => ({ resolveForeground: vi.fn() }))
vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: resolveForeground
}))

const owner = {
  sessionId: 'owned-pty',
  incarnationId: 'owned-incarnation',
  pid: 101,
  createdAt: 1000,
  isAlive: true,
  wslDistro: null as string | null
}

function input() {
  return {
    sessionId: owner.sessionId,
    incarnationId: owner.incarnationId as string | undefined,
    foregroundProcess: 'bun.exe' as string | null,
    readSession: vi.fn(async () => ({ ...owner })),
    isCurrent: vi.fn(() => true)
  }
}

describe('foreground identity for adopted daemon workers', () => {
  beforeEach(() => {
    resolveForeground.mockReset().mockResolvedValue({ available: true, processName: 'omp' })
  })

  it('recognizes the interpreter under the same live PTY before and after the scan', async () => {
    const request = input()
    await expect(resolveDaemonWrapperForeground(request)).resolves.toEqual({
      available: true,
      processName: 'omp'
    })
    expect(resolveForeground).toHaveBeenCalledWith(101, 'bun.exe', {
      fresh: true,
      forceProcessScan: true
    })
    expect(request.readSession).toHaveBeenCalledTimes(2)
  })

  it.each([
    { incarnationId: 'replacement' },
    { pid: 202 },
    { createdAt: 2000 },
    { isAlive: false },
    { wslDistro: 'Ubuntu' }
  ])('refuses ownership changed during the process scan: %j', async (changed) => {
    const request = input()
    request.readSession.mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, ...changed })
    await expect(resolveDaemonWrapperForeground(request)).resolves.toEqual({
      available: false,
      processName: 'bun.exe'
    })
  })

  it('does not query local processes for a WSL-owned session', async () => {
    const request = input()
    request.readSession.mockResolvedValue({ ...owner, wslDistro: 'Ubuntu' })
    await expect(resolveDaemonWrapperForeground(request)).resolves.toMatchObject({
      available: false
    })
    expect(resolveForeground).not.toHaveBeenCalled()
  })

  it('keeps missing inventory and disconnected owners unverified', async () => {
    const request = input()
    request.readSession.mockRejectedValue(new Error('socket_closed'))
    await expect(resolveDaemonWrapperForeground(request)).resolves.toEqual({
      available: false,
      processName: 'bun.exe'
    })
    expect(resolveForeground).not.toHaveBeenCalled()
  })

  it('refuses a daemon replacement while the process scan is in progress', async () => {
    const request = input()
    resolveForeground.mockImplementation(async () => {
      request.isCurrent.mockReturnValue(false)
      return { available: true, processName: 'omp' }
    })
    await expect(resolveDaemonWrapperForeground(request)).resolves.toMatchObject({
      available: false
    })
  })

  it('never turns an unknown or unreadable wrapper into an exited process', async () => {
    resolveForeground.mockResolvedValue({ available: false, processName: null })
    await expect(resolveDaemonWrapperForeground(input())).resolves.toEqual({
      available: false,
      processName: 'bun.exe'
    })
    resolveForeground.mockResolvedValue({ available: true, processName: 'zsh' })
    await expect(resolveDaemonWrapperForeground(input())).resolves.toEqual({
      available: true,
      processName: 'bun.exe'
    })
  })

  it('leaves recognized agents and actual shells on the daemon path', async () => {
    for (const foregroundProcess of ['omp', 'codex', 'zsh', null]) {
      const request = { ...input(), foregroundProcess }
      await expect(resolveDaemonWrapperForeground(request)).resolves.toEqual({
        available: true,
        processName: foregroundProcess
      })
      expect(request.readSession).not.toHaveBeenCalled()
    }
    expect(resolveForeground).not.toHaveBeenCalled()
  })

  it('requires a known PTY incarnation before resolving a wrapper', async () => {
    const request = { ...input(), incarnationId: undefined }
    await expect(resolveDaemonWrapperForeground(request)).resolves.toMatchObject({
      available: false
    })
    expect(request.readSession).not.toHaveBeenCalled()
  })
})
