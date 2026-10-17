import { join, posix, win32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { upsertTableSettingsInContent } from './codex-config-settings-upsert'
import { observeAgentStateFile } from './codex-path-observation'

// Why: Codex >= 0.157 auto-starts an app-server daemon bound to this socket
// under CODEX_HOME; OmniConsole's managed homes push it past sun_path, so every
// launch fails. Older Codex only warns on the unknown feature key, and a launch
// flag (--no-daemon) would be rejected by those versions instead.
const CODEX_DAEMON_SOCKET_SEGMENTS = ['app-server-control', 'app-server-control.sock'] as const
const CODEX_DAEMON_FEATURE_UPDATE = new Map([['daemon_auto_start', 'false']])

/** sun_path size; Rust's std refuses paths that leave no room for the NUL. */
function getUnixSocketPathCapacity(platform: NodeJS.Platform): number {
  return platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' ? 104 : 108
}

export function codexDaemonSocketPathExceedsLimit(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  // Why: a WSL UNC home is bound by Linux Codex at its guest path.
  const wslPath = parseWslUncPath(codexHomePath)?.linuxPath
  const socketPath =
    wslPath !== undefined
      ? posix.join(wslPath, ...CODEX_DAEMON_SOCKET_SEGMENTS)
      : (platform === 'win32' ? win32 : posix).join(codexHomePath, ...CODEX_DAEMON_SOCKET_SEGMENTS)
  const capacity = getUnixSocketPathCapacity(wslPath !== undefined ? 'linux' : platform)
  return Buffer.byteLength(socketPath, 'utf8') >= capacity
}

/** Forces `[features] daemon_auto_start = false` when the home's socket path cannot bind. */
export function disableCodexDaemonAutoStartForSocketPath(
  config: string,
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!codexDaemonSocketPathExceedsLimit(codexHomePath, platform)) {
    return config
  }
  // Why: an explicit `true` would reproduce the crash, so it is overridden too.
  return upsertTableSettingsInContent(config, 'features', CODEX_DAEMON_FEATURE_UPDATE)
}

/** File-level twin for homes whose config the mirror did not (re)write this pass. */
export function ensureCodexDaemonAutoStartFitsSocketPath(
  codexHomePath: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (!codexDaemonSocketPathExceedsLimit(codexHomePath, platform)) {
    return
  }
  const configPath = join(codexHomePath, 'config.toml')
  try {
    const observation = observeAgentStateFile(configPath)
    if (observation.kind === 'indeterminate') {
      return
    }
    const current = observation.kind === 'present' ? observation.value : null
    const next = disableCodexDaemonAutoStartForSocketPath(current ?? '', codexHomePath, platform)
    if (next !== current) {
      // Why: a guarded write lets a concurrent Codex trust write win; the next pass retries.
      writeFileAtomicallyIfUnchanged(configPath, current, next)
    }
  } catch (error) {
    console.warn('[codex] Failed to disable daemon auto-start for managed home:', error)
  }
}
