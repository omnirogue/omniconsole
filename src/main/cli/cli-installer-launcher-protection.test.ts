import { lstat, readFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() }
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

it.skipIf(process.platform === 'win32')(
  'registers outside the app when its bundled launcher is first on PATH',
  async () => {
    const fixture = await makeFixture()
    const resourcesPath = await createPackagedMacLauncher(fixture.root)
    const launcherPath = join(resourcesPath, 'bin', 'omni')
    const original = await readFile(launcherPath, 'utf8')
    const homePath = join(fixture.root, 'home')
    const installer = new CliInstaller({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath,
      homePath,
      userDataPath: fixture.userDataPath,
      appPath: fixture.appPath,
      defaultMacCommandPath: join(fixture.root, 'absent', 'omni'),
      processPathEnv: `${join(resourcesPath, 'bin')}:${join(homePath, '.local', 'bin')}`
    })
    const installed = await installer.install()
    expect(installed.commandPath).toBe(join(homePath, '.local', 'bin', 'omni'))
    expect(installed.state).toBe('installed')
    await expect(readlink(installed.commandPath!)).resolves.toBe(launcherPath)
    await installer.remove()
    expect((await lstat(launcherPath)).isSymbolicLink()).toBe(false)
    await expect(readFile(launcherPath, 'utf8')).resolves.toBe(original)
  }
)

it.skipIf(process.platform === 'win32')(
  'rejects an explicit override pointing at the bundled launcher',
  async () => {
    const fixture = await makeFixture()
    const resourcesPath = await createPackagedMacLauncher(fixture.root)
    const launcherPath = join(resourcesPath, 'bin', 'omni')
    const original = await readFile(launcherPath, 'utf8')
    const installer = new CliInstaller({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath,
      userDataPath: fixture.userDataPath,
      appPath: fixture.appPath,
      commandPathOverride: launcherPath,
      processPathEnv: join(resourcesPath, 'bin')
    })
    await expect(installer.install()).rejects.toThrow(
      'bundled CLI launcher cannot be replaced or removed'
    )
    await expect(installer.remove()).rejects.toThrow(
      'bundled CLI launcher cannot be replaced or removed'
    )
    await expect(readFile(launcherPath, 'utf8')).resolves.toBe(original)
  }
)
