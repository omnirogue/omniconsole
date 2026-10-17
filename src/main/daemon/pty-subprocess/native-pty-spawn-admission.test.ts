import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, wrapMock, exitStatusMock, assignJobMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  wrapMock: vi.fn(),
  exitStatusMock: vi.fn(),
  assignJobMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../../providers/macos-tcc-login-shell', () => ({
  wrapShellSpawnForMacosTccAttribution: wrapMock,
  hostReportsChildExitStatus: exitStatusMock
}))
vi.mock('../../windows/windows-pty-job', () => ({
  assignHostProcessToKillOnCloseJob: assignJobMock
}))

import { spawnNativeDaemonPty } from './native-pty-spawn'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const spawnedProcess = { pid: 1234 }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function spawnArgs(env: Record<string, string> = {}): Parameters<typeof spawnNativeDaemonPty>[0] {
  return {
    shellPath: '/shell/primary',
    shellArgs: ['-l'],
    spawnCwd: '/workspace',
    env,
    cols: 80,
    rows: 24,
    windowsFallbackAttempts: ['primary', 'fallback', 'last'].map((name) => ({
      shellPath: `/shell/${name}`,
      shellArgs: [`--${name}`],
      effectiveCwd: `/workspace/${name}`,
      validationCwd: '/workspace',
      startupCommandDeliveredInShellArgs: name === 'fallback'
    })),
    onMacosTccSpawnStrategy: vi.fn()
  }
}

beforeEach(() => {
  setPlatform('linux')
  vi.resetAllMocks()
  spawnMock.mockReturnValue(spawnedProcess)
  wrapMock.mockImplementation((file: string, args: string[]) => ({ file, args }))
  exitStatusMock.mockReturnValue(true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
})

describe('native PTY Hub task admission', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'rejects bound execution before any native or job side effect on %s',
    (platform) => {
      setPlatform(platform)
      const args = spawnArgs({ OMNI_TASK_ID: 'task-1' })

      expect(() => spawnNativeDaemonPty(args)).toThrowError(
        expect.objectContaining({ code: 'consumer_fenced' })
      )
      expect(wrapMock).not.toHaveBeenCalled()
      expect(assignJobMock).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
      expect(args.onMacosTccSpawnStrategy).not.toHaveBeenCalled()
    }
  )

  it('rejects mixed-case Windows task bindings before considering fallback shells', () => {
    setPlatform('win32')

    expect(() =>
      spawnNativeDaemonPty(spawnArgs({ OMNI_TASK_ID: '', Omni_Task_Id: 'task-1' }))
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(wrapMock).not.toHaveBeenCalled()
    expect(assignJobMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('allows an unrelated mixed-case variable on POSIX and preserves native spawn options', () => {
    const args = spawnArgs({ Omni_Task_Id: 'ordinary-variable', TERM: 'vt100' })

    expect(spawnNativeDaemonPty(args)).toEqual({
      process: spawnedProcess,
      shellPath: '/shell/primary',
      spawnCwd: '/workspace',
      reportsChildExitStatus: true
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith('/shell/primary', ['-l'], {
      name: 'vt100',
      cols: 80,
      rows: 24,
      cwd: '/workspace',
      env: args.env
    })
    expect(assignJobMock).not.toHaveBeenCalled()
    expect(args.onMacosTccSpawnStrategy).toHaveBeenCalledWith('direct')
  })

  it('keeps unbound Windows fallback behavior and assigns the job before native spawning', () => {
    setPlatform('win32')
    spawnMock.mockImplementationOnce(() => {
      throw new Error('primary shell failed')
    })
    const args = spawnArgs()

    expect(spawnNativeDaemonPty(args)).toEqual({
      process: spawnedProcess,
      shellPath: '/shell/fallback',
      spawnCwd: '/workspace/fallback',
      startupCommandDeliveredInShellArgs: true,
      reportsChildExitStatus: true
    })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      '/shell/fallback',
      ['--fallback'],
      expect.objectContaining({ cwd: '/workspace/fallback', useConptyDll: true })
    )
    expect(assignJobMock).toHaveBeenCalledTimes(2)
    expect(assignJobMock.mock.invocationCallOrder[0]).toBeLessThan(
      spawnMock.mock.invocationCallOrder[0]!
    )
    expect(assignJobMock.mock.invocationCallOrder[1]).toBeLessThan(
      spawnMock.mock.invocationCallOrder[1]!
    )
  })

  it.each([1, 2])('rechecks admission after native attempt %i fails', (boundAfterAttempt) => {
    setPlatform('win32')
    const args = spawnArgs()
    let attempts = 0
    spawnMock.mockImplementation(() => {
      attempts += 1
      if (attempts === boundAfterAttempt) {
        args.env.oMnI_TaSk_Id = 'task-1'
      }
      throw new Error('native shell failed')
    })

    expect(() => spawnNativeDaemonPty(args)).toThrowError(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(spawnMock).toHaveBeenCalledTimes(boundAfterAttempt)
    expect(wrapMock).toHaveBeenCalledTimes(boundAfterAttempt)
    expect(assignJobMock).toHaveBeenCalledTimes(boundAfterAttempt)
    expect(args.onMacosTccSpawnStrategy).not.toHaveBeenCalled()
  })
})
