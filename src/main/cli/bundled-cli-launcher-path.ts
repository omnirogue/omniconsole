import { join } from 'node:path'

// Why `omni-ide` on Linux: GNOME OmniConsole ships /usr/bin/omni, so the CLI never claims that name.
export const LINUX_CLI_COMMAND_NAME = 'omni-ide'

/** Absolute path of the CLI launcher this app ships in its own resources bundle.
 *  Lives apart from cli-installer so callers that only need the path (PTY env
 *  assembly) don't pull in the installer's `electron` dependency. */
export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'omni')
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_CLI_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'omni.exe')
  }
  return null
}
