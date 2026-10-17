import { chmod, lstat, mkdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, lstat: vi.fn(actual.lstat), stat: vi.fn(actual.stat) }
})

import { buildAppImageCliWrapper } from './appimage-cli-wrapper'
import { buildWindowsForwarder } from './cli-dev-launcher'
import { CliInstaller, getBundledLauncherPath } from './cli-installer'
import { quoteShell } from './cli-install-path-format'
import { makeFixture } from './cli-installer-test-fixtures'

const roots: string[] = []

async function commandFixture(
  platform: NodeJS.Platform,
  mode: number,
  stale = false,
  appImage = false
) {
  const fixture = await makeFixture()
  roots.push(fixture.root)
  const directory = join(fixture.root, "command bin's")
  const resourcesPath = join(fixture.root, 'resources')
  const launcherPath = getBundledLauncherPath(platform, resourcesPath) as string
  const commandPath = join(directory, platform === 'win32' ? 'omni.cmd' : basename(launcherPath))
  const currentTarget = stale
    ? join(
        fixture.root,
        'Old.app',
        'Contents',
        platform === 'darwin' ? 'Resources' : 'resources',
        'bin',
        basename(launcherPath)
      )
    : launcherPath

  await mkdir(join(resourcesPath, 'bin'), { recursive: true })
  await writeFile(launcherPath, '#!/usr/bin/env bash\n', { mode: 0o755 })
  await mkdir(directory)
  // Why: set only this user-owned fixture's mode explicitly, independent of the caller's umask.
  await chmod(directory, mode)
  if (appImage) {
    await writeFile(commandPath, buildAppImageCliWrapper(currentTarget))
  } else {
    await (platform === 'win32'
      ? writeFile(commandPath, buildWindowsForwarder(currentTarget))
      : symlink(currentTarget, commandPath))
  }

  const privilegedRunner = vi.fn(async () => {})
  const installer = new CliInstaller({
    platform,
    isPackaged: true,
    resourcesPath,
    appImagePath: appImage ? launcherPath : undefined,
    userDataPath: fixture.userDataPath,
    appPath: fixture.appPath,
    homePath: fixture.root,
    commandPathOverride: commandPath,
    defaultMacCommandPath: commandPath,
    processPathEnv: directory,
    privilegedRunner,
    userPathReader: async () => ({ state: 'success', value: directory, expandable: false })
  })
  return {
    ...fixture,
    directory,
    commandPath,
    launcherPath,
    currentTarget,
    installer,
    privilegedRunner
  }
}

async function denyCommandAccess(
  fixture: Awaited<ReturnType<typeof commandFixture>>,
  code: 'EACCES' | 'EPERM',
  parentStatFails = false,
  directoryMode = 0o40700
) {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const error = Object.assign(new Error('command access denied'), { code })
  vi.mocked(lstat).mockImplementation((path) =>
    path === fixture.commandPath ? Promise.reject(error) : actual.lstat(path)
  )
  const directoryStats = await actual.stat(fixture.directory)
  // Why: model root-owned directories without changing ownership or permissions on disk.
  Object.assign(directoryStats, { mode: directoryMode, uid: 0, gid: 0 })
  vi.mocked(stat).mockImplementation((path) =>
    path !== fixture.directory
      ? actual.stat(path)
      : parentStatFails
        ? Promise.reject(Object.assign(new Error('parent stat denied'), { code: 'EACCES' }))
        : Promise.resolve(directoryStats)
  )
  return { actual, error }
}

describe.skipIf(process.platform === 'win32')('CLI command directory inspection', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
    vi.mocked(lstat).mockReset().mockImplementation(actual.lstat)
    vi.mocked(stat).mockReset().mockImplementation(actual.stat)
  })

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  describe.each(['darwin', 'linux'] as const)('%s', (platform) => {
    it.each([false, true])(
      'preserves commands in a user-owned 0700 directory and repairs stale launchers (stale=%s)',
      async (stale) => {
        const fixture = await commandFixture(platform, 0o700, stale)
        const status = await fixture.installer.getStatus()

        expect(status).toMatchObject({
          state: stale ? 'stale' : 'installed',
          supported: true,
          installMethod: 'symlink',
          currentTarget: fixture.currentTarget,
          detail: stale
            ? `${fixture.commandPath} points to an older OmniConsole launcher.`
            : `Registered at ${fixture.commandPath}.`
        })
        expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)

        await expect(fixture.installer.install()).resolves.toMatchObject({
          state: 'installed',
          supported: true,
          currentTarget: fixture.launcherPath
        })
        expect(fixture.privilegedRunner).not.toHaveBeenCalled()
        await expect(readlink(fixture.commandPath)).resolves.toBe(fixture.launcherPath)
        expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700)
      }
    )

    it.each([false, true])('preserves the 0755 directory result (stale=%s)', async (stale) => {
      const fixture = await commandFixture(platform, 0o755, stale)
      await expect(fixture.installer.getStatus()).resolves.toMatchObject({
        state: stale ? 'stale' : 'installed',
        supported: true,
        currentTarget: fixture.currentTarget,
        detail: stale
          ? `${fixture.commandPath} points to an older OmniConsole launcher.`
          : `Registered at ${fixture.commandPath}.`
      })
    })

    it.each([0o701, 0o704, 0o750, 0o770])(
      'preserves an accessible command regardless of other-user permissions (mode=%i)',
      async (mode) => {
        const fixture = await commandFixture(platform, mode)
        const status = await fixture.installer.getStatus()
        expect(status).toMatchObject({
          state: 'installed',
          supported: true,
          detail: `Registered at ${fixture.commandPath}.`
        })
        expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
      }
    )

    it.each([
      ['ENOENT', false],
      ['ENOENT', true],
      ['EACCES', false],
      ['EACCES', true]
    ] as const)(
      'does not probe the parent after successful inspection despite a %s stat mock (stale=%s)',
      async (code, stale) => {
        const fixture = await commandFixture(platform, 0o700, stale)
        const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
        vi.mocked(stat).mockImplementation((path) => {
          if (path === fixture.directory) {
            return Promise.reject(Object.assign(new Error('parent stat failed'), { code }))
          }
          return actual.stat(path)
        })

        await expect(fixture.installer.getStatus()).resolves.toMatchObject({
          state: stale ? 'stale' : 'installed',
          supported: true,
          currentTarget: fixture.currentTarget,
          detail: stale
            ? `${fixture.commandPath} points to an older OmniConsole launcher.`
            : `Registered at ${fixture.commandPath}.`
        })
        expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
      }
    )

    it('leaves unknown commands as existing conflicts without probing the parent', async () => {
      const fixture = await commandFixture(platform, 0o700)
      await rm(fixture.commandPath)
      await symlink(join(fixture.root, 'unmanaged'), fixture.commandPath)
      await expect(fixture.installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        supported: true,
        detail: `${fixture.commandPath} points to a non-OmniConsole launcher.`
      })
      expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
    })
  })

  describe.each([
    ['darwin', 'symlink', false],
    ['linux', 'symlink', false],
    ['linux', 'wrapper', true]
  ] as const)('%s %s permission failures', (platform, installMethod, appImage) => {
    it.each(['EACCES', 'EPERM'] as const)(
      'reports a root-owned 0700 parent after %s and blocks installation',
      async (code) => {
        const fixture = await commandFixture(platform, 0o755, false, appImage)
        const { actual } = await denyCommandAccess(fixture, code)
        const status = await fixture.installer.getStatus()
        expect(status).toMatchObject({
          state: 'conflict',
          supported: false,
          installMethod,
          currentTarget: null
        })
        expect(status.detail).toContain(fixture.commandPath)
        expect(status.detail).toContain(`Command directory ${fixture.directory} has mode 0700`)
        expect(status.detail).toContain('owner UID 0, GID 0')
        expect(status.detail).toContain('the app cannot read it')
        expect(
          status.detail?.endsWith(`Fix: sudo chmod 755 ${quoteShell(fixture.directory)}`)
        ).toBe(true)
        await expect(fixture.installer.install()).rejects.toThrow(status.detail as string)
        expect(fixture.privilegedRunner).not.toHaveBeenCalled()
        expect((await actual.stat(fixture.directory)).mode & 0o777).toBe(0o755)
        await expect(
          appImage
            ? actual.readFile(fixture.commandPath, 'utf8')
            : actual.readlink(fixture.commandPath)
        ).resolves.toBe(
          appImage ? buildAppImageCliWrapper(fixture.currentTarget) : fixture.currentTarget
        )
      }
    )

    it('rethrows the original EACCES when the parent stat also fails', async () => {
      const fixture = await commandFixture(platform, 0o755, false, appImage)
      const { error } = await denyCommandAccess(fixture, 'EACCES', true)
      await expect(fixture.installer.getStatus()).rejects.toBe(error)
      expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(true)
    })
  })

  it('reports an unreadable command entry in a 0755 directory without suggesting folder chmod', async () => {
    const fixture = await commandFixture('darwin', 0o755)
    await denyCommandAccess(fixture, 'EACCES', false, 0o40755)
    const status = await fixture.installer.getStatus()
    expect(status).toMatchObject({ state: 'conflict', supported: false, currentTarget: null })
    expect(status.detail).toContain(`Cannot read command entry ${fixture.commandPath}`)
    expect(status.detail).toContain(`Command directory ${fixture.directory} has mode 0755`)
    expect(status.detail).not.toContain('chmod')
    expect(status.detail).toContain('other users can read and traverse it')
    expect(status.detail?.endsWith(`Check: ls -l ${quoteShell(fixture.commandPath)}`)).toBe(true)
  })

  it('preserves the Windows EACCES error without probing the parent', async () => {
    const fixture = await commandFixture('win32', 0o755)
    const { error } = await denyCommandAccess(fixture, 'EACCES')
    await expect(fixture.installer.getStatus()).rejects.toBe(error)
    expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
  })

  it.each([false, true])(
    'leaves Windows wrappers unchanged in a 0700 directory (stale=%s)',
    async (stale) => {
      const fixture = await commandFixture('win32', 0o700, stale)
      await expect(fixture.installer.getStatus()).resolves.toMatchObject({
        state: stale ? 'stale' : 'installed',
        supported: true,
        detail: stale
          ? `${fixture.commandPath} points to a different launcher.`
          : `Registered at ${fixture.commandPath}.`
      })
      expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
    }
  )

  it.each([false, true])(
    'preserves accessible Linux AppImage wrappers (stale=%s)',
    async (stale) => {
      const fixture = await commandFixture('linux', 0o700, stale, true)
      const status = await fixture.installer.getStatus()
      expect(status).toMatchObject({
        state: stale ? 'stale' : 'installed',
        supported: true,
        installMethod: 'wrapper',
        detail: stale
          ? `${fixture.commandPath} points to a different launcher.`
          : `Registered at ${fixture.commandPath}.`
      })
      expect(vi.mocked(stat).mock.calls.some(([path]) => path === fixture.directory)).toBe(false)
      await expect(fixture.installer.install()).resolves.toMatchObject({
        state: 'installed',
        supported: true
      })
      expect(fixture.privilegedRunner).not.toHaveBeenCalled()
      expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700)
    }
  )
})
