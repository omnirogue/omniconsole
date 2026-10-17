import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '../../../src/shared/child-process/run-process'
import { cleanupE2EProfileCrashpad } from './electron-crashpad-cleanup'

vi.mock('../../../src/shared/child-process/run-process', () => ({ runProcessSync: vi.fn() }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realpathNative = realpathSync.native

it('does not enumerate processes on Windows', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const kill = vi.spyOn(process, 'kill')
  try {
    await cleanupE2EProfileCrashpad('/unused-profile', '/unused-electron')
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  } finally {
    kill.mockRestore()
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe.skipIf(process.platform === 'win32').each(['darwin', 'linux'])(
  'exact-profile Crashpad cleanup on %s',
  (platform) => {
    let fixtureDir: string
    let profile: string
    let siblingProfile: string
    let electron: string
    let executable: string
    let alive: boolean
    let startedAt: string
    let processExecutable: string
    let command: string
    let onIdentityRead: () => void
    const pid = 2_000_001

    function crashpadCommand(database: string): string {
      return `${executable} --no-rate-limit --database=${database} --annotation=_productName=OmniConsole Dev`
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca crashpad ownership-'))
      profile = path.join(fixtureDir, 'orca-e2e-userdata-owned')
      siblingProfile = `${profile}-unrelated`
      mkdirSync(path.join(profile, 'Crashpad'), { recursive: true })
      mkdirSync(path.join(siblingProfile, 'Crashpad'), { recursive: true })
      electron = path.join(
        fixtureDir,
        platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
      )
      executable = path.resolve(
        path.dirname(electron),
        platform === 'darwin'
          ? '../Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
          : 'chrome_crashpad_handler'
      )
      mkdirSync(path.dirname(executable), { recursive: true })
      writeFileSync(executable, '')
      processExecutable = executable
      command = crashpadCommand(path.join(profile, 'Crashpad'))
      alive = true
      startedAt = 'Tue Sep 15 18:01:01 2026'
      onIdentityRead = () => undefined
      vi.spyOn(realpathSync, 'native').mockImplementation(((value: string) => {
        if (value === `/proc/${pid}/exe`) {
          return processExecutable
        }
        return realpathNative(value)
      }) as typeof realpathSync.native)
      vi.mocked(runProcessSync).mockImplementation(({ args }) => {
        let stdout = ''
        if (args?.includes('pid=,comm=')) {
          stdout = `${pid} ${platform === 'linux' ? 'chrome_crashpad' : executable}\n`
        } else if (alive && args?.includes('lstart=,comm=')) {
          onIdentityRead()
          stdout = `${startedAt} ${platform === 'linux' ? 'chrome_crashpad' : processExecutable}\n`
        } else if (alive && args?.includes('command=')) {
          stdout = command
        }
        return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
      })
      vi.spyOn(process, 'kill').mockImplementation(() => {
        alive = false
        return true
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', originalPlatform)
      rmSync(fixtureDir, { recursive: true, force: true })
    })

    it('terminates only the verified helper and accepts canonical profile aliases', async () => {
      const alias = path.join(fixtureDir, 'profile alias')
      symlinkSync(profile, alias, 'dir')
      command = crashpadCommand(path.join(alias, 'Crashpad'))
      await cleanupE2EProfileCrashpad(profile, electron)
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(pid, 'SIGTERM')
      expect(alive).toBe(false)
    })

    it.skipIf(platform !== 'linux')(
      'does not trust a matching comm without a procfs executable',
      async () => {
        processExecutable = ''
        await cleanupE2EProfileCrashpad(profile, electron)
        expect(process.kill).not.toHaveBeenCalled()
      }
    )

    it.each([
      'sibling profile',
      'lookalike executable',
      'different command',
      'embedded flag',
      'duplicate flag'
    ])('does not signal a process with %s', async (mismatch) => {
      if (mismatch === 'sibling profile') {
        command = crashpadCommand(path.join(siblingProfile, 'Crashpad'))
      } else if (mismatch === 'lookalike executable') {
        processExecutable = `${executable}-unrelated`
        writeFileSync(processExecutable, '')
      } else if (mismatch === 'different command') {
        command = `/usr/bin/printf --database=${path.join(profile, 'Crashpad')}`
      } else if (mismatch === 'embedded flag') {
        command = `${executable} --annotation=--database=${path.join(profile, 'Crashpad')}`
      } else {
        command += ` --database=${path.join(siblingProfile, 'Crashpad')}`
      }
      await cleanupE2EProfileCrashpad(profile, electron)
      expect(process.kill).not.toHaveBeenCalled()
    })

    it('rechecks the start time immediately before signalling a recycled PID', async () => {
      let reads = 0
      onIdentityRead = () => {
        reads += 1
        if (reads === 2) {
          startedAt = 'Tue Sep 15 18:01:02 2026'
        }
      }
      await cleanupE2EProfileCrashpad(profile, electron)
      expect(process.kill).not.toHaveBeenCalled()
    })

    it('does not escalate against a new process that reuses the PID after TERM', async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        startedAt = 'Tue Sep 15 18:01:02 2026'
        return true
      })
      await cleanupE2EProfileCrashpad(profile, electron)
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(pid, 'SIGTERM')
    })

    it('escalates only while the same profile-owned process remains alive', async () => {
      vi.useFakeTimers()
      vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        alive = signal !== 'SIGKILL'
        return true
      })
      const cleanup = cleanupE2EProfileCrashpad(profile, electron)
      await vi.runAllTimersAsync()
      await cleanup
      expect(vi.mocked(process.kill).mock.calls).toEqual([
        [pid, 'SIGTERM'],
        [pid, 'SIGKILL']
      ])
      expect(alive).toBe(false)
    })
  }
)
