import { lstat, readFile, readlink, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { CliInstallMethod, CliInstallStatus } from '../../shared/cli-install-types'
import { buildAppImageCliWrapper } from './appimage-cli-wrapper'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from './cli-install-constants'
import { buildWindowsForwarder, extractManagedUnixLauncherTarget } from './cli-dev-launcher'
import { isMissingError, isPermissionError } from './cli-install-errors'
import { CliInstallLocation } from './cli-install-location'
import { isPathInsideOrEqual, quoteShell, samePathEntry } from './cli-install-path-format'

export class CliCommandInspection extends CliInstallLocation {
  protected async inspectAppImageWrapper(
    commandPath: string,
    appImagePath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath: appImagePath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an OmniConsole launcher script.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildAppImageCliWrapper(appImagePath)
      return this.buildStatus({
        commandPath,
        launcherPath: appImagePath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: appImagePath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      return this.inspectUnixCommandError(error, commandPath, appImagePath, 'wrapper')
    }
  }

  protected async inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) {
        if (stats.isFile()) {
          const currentContent = await readFile(commandPath, 'utf8')
          const managedTarget = extractManagedUnixLauncherTarget(currentContent)
          if (managedTarget) {
            return this.buildStatus({
              commandPath,
              launcherPath,
              installMethod: 'symlink',
              supported: true,
              state: 'stale',
              currentTarget: managedTarget,
              detail: `${commandPath} contains an older OmniConsole launcher.`
            })
          }
        }

        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an OmniConsole symlink.`
        })
      }

      const currentTarget = await readlink(commandPath)
      const resolvedCurrentTarget = resolve(dirname(commandPath), currentTarget)
      const resolvedLauncher = resolve(launcherPath)
      const isInstalled = resolvedCurrentTarget === resolvedLauncher
      const isManagedStaleTarget =
        !isInstalled && this.isManagedSymlinkTarget(resolvedCurrentTarget, launcherPath)
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'symlink',
        supported: true,
        state: isInstalled ? 'installed' : isManagedStaleTarget ? 'stale' : 'conflict',
        currentTarget: resolvedCurrentTarget,
        detail: isInstalled
          ? `Registered at ${commandPath}.`
          : isManagedStaleTarget
            ? `${commandPath} points to an older OmniConsole launcher.`
            : `${commandPath} points to a non-OmniConsole launcher.`
      })
    } catch (error) {
      return this.inspectUnixCommandError(error, commandPath, launcherPath, 'symlink')
    }
  }

  private async inspectUnixCommandError(
    error: unknown,
    commandPath: string,
    launcherPath: string,
    installMethod: CliInstallMethod
  ): Promise<CliInstallStatus> {
    if (isMissingError(error)) {
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod,
        supported: true,
        state: 'not_installed',
        currentTarget: null,
        detail: `Register ${commandPath} to use OmniConsole from the terminal.`
      })
    }
    if (!isPermissionError(error)) {
      throw error
    }
    const directory = dirname(commandPath)
    let stats
    try {
      stats = await stat(directory)
    } catch {
      // Why: a failed parent probe must preserve the original command-access error.
      throw error
    }
    const mode = (stats.mode & 0o7777).toString(8).padStart(4, '0')
    const advice =
      (stats.mode & 0o005) !== 0o005
        ? `the app cannot read it. Fix: sudo chmod 755 ${quoteShell(directory)}`
        : `other users can read and traverse it. Check: ls -l ${quoteShell(commandPath)}`
    return this.buildStatus({
      commandPath,
      launcherPath,
      installMethod,
      state: 'conflict',
      supported: false,
      currentTarget: null,
      detail:
        `Cannot read command entry ${commandPath}. Command directory ${directory} has mode ${mode} ` +
        `(owner UID ${stats.uid}, GID ${stats.gid}); ${advice}`
    })
  }

  protected isManagedSymlinkTarget(resolvedTarget: string, launcherPath: string): boolean {
    const expectedName = basename(launcherPath)
    if (this.isPackaged && this.isSiblingDevLauncherTarget(resolvedTarget, expectedName)) {
      return true
    }

    if (basename(resolvedTarget) !== expectedName) {
      return false
    }

    const devLauncherDir = resolve(this.userDataPath, ...DEV_LAUNCHER_DIR)
    if (isPathInsideOrEqual(devLauncherDir, resolvedTarget)) {
      return true
    }

    if (this.platform === 'darwin') {
      // Why: reclaim symlinks to an older OmniConsole.app launcher, but never replace arbitrary user-owned symlinks.
      return /(?:^|[/\\])[^/\\]+\.app[/\\]Contents[/\\]Resources[/\\]bin[/\\][^/\\]+$/.test(
        resolvedTarget
      )
    }

    if (this.platform === 'linux') {
      return /(?:^|[/\\])resources[/\\]bin[/\\][^/\\]+$/.test(resolvedTarget)
    }

    return false
  }

  protected isSiblingDevLauncherTarget(
    resolvedTarget: string,
    packagedLauncherName: string
  ): boolean {
    if (![packagedLauncherName, DEV_COMMAND_NAME].includes(basename(resolvedTarget))) {
      return false
    }

    const packagedUserDataPath = resolve(this.userDataPath)
    const siblingDevUserDataPath = `${packagedUserDataPath}-dev`
    const siblingDevLauncherDir = resolve(siblingDevUserDataPath, ...DEV_LAUNCHER_DIR)

    // Why: dev builds generate launchers under the sibling `*-dev` profile; packaged OmniConsole must reclaim that command.
    return (
      basename(siblingDevUserDataPath) === `${basename(packagedUserDataPath)}-dev` &&
      isPathInsideOrEqual(siblingDevLauncherDir, resolvedTarget)
    )
  }

  protected isLinuxAppImage(): boolean {
    return this.platform === 'linux' && Boolean(this.appImagePath)
  }

  protected isWindowsPackagedBundledCommand(
    commandPath: string | null,
    launcherPath: string | null
  ): boolean {
    return (
      this.platform === 'win32' &&
      this.isPackaged &&
      commandPath !== null &&
      launcherPath !== null &&
      samePathEntry('win32', commandPath, launcherPath)
    )
  }

  protected async inspectWindowsWrapper(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an OmniConsole launcher script.`
        })
      }

      if (this.isWindowsPackagedBundledCommand(commandPath, launcherPath)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'installed',
          currentTarget: launcherPath,
          detail: `Registered at ${commandPath}.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildWindowsForwarder(launcherPath)
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: launcherPath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use OmniConsole from Command Prompt or PowerShell.`
        })
      }
      throw error
    }
  }

  protected buildStatus(args: {
    commandPath: string
    launcherPath: string
    installMethod: CliInstallMethod
    supported: boolean
    state: CliInstallStatus['state']
    currentTarget: string | null
    detail: string | null
  }): CliInstallStatus {
    return {
      platform: this.platform,
      commandName: this.commandName,
      commandPath: args.commandPath,
      pathDirectory: dirname(args.commandPath),
      pathConfigured: false,
      launcherPath: args.launcherPath,
      installMethod: args.installMethod,
      supported: args.supported,
      state: args.state,
      currentTarget: args.currentTarget,
      unsupportedReason: null,
      detail: args.detail
    }
  }
}
