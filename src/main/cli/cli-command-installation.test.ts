import type * as FsPromises from 'node:fs/promises'
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { CliCommandInstallation } from './cli-command-installation'
import { quoteShell } from './cli-install-path-format'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, mkdir: vi.fn(actual.mkdir), symlink: vi.fn(actual.symlink) }
})

class TestInstallation extends CliCommandInstallation {
  install(commandPath: string, launcherPath: string): Promise<void> {
    return this.installSymlink(
      this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'symlink',
        supported: true,
        state: 'not_installed',
        currentTarget: null,
        detail: null
      })
    )
  }
}

describe.skipIf(process.platform === 'win32')('macOS privileged CLI directory creation', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omni-cli-directory-mode-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it.each(['missing', 'existing'] as const)(
    'uses 0755 for new parents and preserves existing modes and owners with a %s command directory',
    async (directoryState) => {
      const parentDir = join(root, "parent's directory")
      const commandDir = join(parentDir, 'bin')
      const commandPath = join(commandDir, 'omni')
      const launcherPath = join(root, "OmniConsole's launcher")
      await writeFile(launcherPath, '#!/bin/sh\n', 'utf8')

      if (directoryState === 'existing') {
        await mkdir(commandDir, { recursive: true })
        await chmod(parentDir, 0o775)
        await chmod(commandDir, 0o775)
      }
      const existingPaths = directoryState === 'existing' ? [root, parentDir, commandDir] : [root]
      const existingStats = await Promise.all(existingPaths.map((path) => lstat(path)))

      const privilegedRunner = vi.fn(async (command: string) => {
        // Why: reproduce the elevated shell's restrictive umask using only unprivileged temp paths.
        const result = await runProcess({
          program: '/bin/sh',
          args: ['-c', `umask 077; ${command}`]
        })
        expect(result.code, result.stderr).toBe(0)
      })
      const installer = new TestInstallation({
        platform: 'darwin',
        isPackaged: true,
        userDataPath: root,
        appPath: root,
        execPath: process.execPath,
        defaultMacCommandPath: commandPath,
        privilegedRunner
      })
      const directWrite = directoryState === 'missing' ? vi.mocked(mkdir) : vi.mocked(symlink)
      directWrite.mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      )

      await installer.install(commandPath, launcherPath)

      expect(privilegedRunner).toHaveBeenCalledTimes(1)
      const command = privilegedRunner.mock.calls[0][0]
      await expect(readlink(commandPath)).resolves.toBe(launcherPath)

      if (directoryState === 'missing') {
        for (const path of [parentDir, commandDir]) {
          expect((await lstat(path)).mode & 0o777).toBe(0o755)
        }
      }
      for (const [index, path] of existingPaths.entries()) {
        const before = existingStats[index]
        const after = await lstat(path)
        expect(after.mode).toBe(before.mode)
        expect(after.uid).toBe(before.uid)
        expect(after.gid).toBe(before.gid)
      }
      expect(command).toMatch(/^umask 022 && mkdir -p /)
      expect(command).not.toMatch(/\b(?:chmod|chown)\b/)
      expect(command).toContain(`ln -sfn ${quoteShell(launcherPath)} ${quoteShell(commandPath)}`)
    }
  )
})
