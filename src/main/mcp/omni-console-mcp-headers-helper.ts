import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  OMNI_CONSOLE_MCP_HEADERS_HELPER_DIR,
  OMNI_CONSOLE_MCP_HEADERS_HELPER_FILE,
  omniConsoleMcpHeadersHelperCommand
} from '../../shared/omni-console-mcp-ledger-headers'

export type OmniConsoleMcpHeadersHelperLocation = {
  isPackaged: boolean
  /** Packaged app resources root (`process.resourcesPath`); the helper ships at `<it>/mcp/`. */
  resourcesPath?: string | null
  /** Dev app root (`app.getAppPath()`); the helper is read from `<it>/resources/mcp/`. */
  appPath?: string | null
  /** Test seam. */
  platform?: NodeJS.Platform
  /** Test seam: directories whose contents do not outlive the process or a reboot. */
  temporaryRoots?: readonly string[]
}

function defaultTemporaryRoots(): string[] {
  return [
    tmpdir(),
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
    '/var/folders',
    '/private/var/folders'
  ]
}

function isInside(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * True when `path` will not survive this app's exit: a macOS translocated copy, a Linux
 * AppImage FUSE mount (`/tmp/.mount_<name><rand>`), or anything under a temp directory.
 * Claude Code runs the helper long after this spawn, also outside the IDE; a vanished helper
 * exits 127 and Claude then connects WITHOUT the ledger headers, silently losing attribution.
 */
function isNonPersistentPath(path: string, temporaryRoots: readonly string[]): boolean {
  if (
    path.includes('/AppTranslocation/') ||
    path.split(sep).some((part) => part.startsWith('.mount_'))
  ) {
    return true
  }
  const candidates = [path]
  try {
    candidates.push(realpathSync(path))
  } catch {
    // Absence is decided by the executable check below.
  }
  return temporaryRoots.some((root) => {
    if (!root || !isAbsolute(root)) {
      return false
    }
    const roots = [root]
    try {
      roots.push(realpathSync(root))
    } catch {
      // A missing temp root contains nothing.
    }
    return candidates.some((candidate) => roots.some((dir) => isInside(candidate, dir)))
  })
}

/** Absolute path of the app-owned helper for this install, before any existence check. */
export function omniConsoleMcpHeadersHelperPath(
  location: OmniConsoleMcpHeadersHelperLocation
): string | null {
  const root = location.isPackaged
    ? location.resourcesPath
    : location.appPath
      ? join(location.appPath, 'resources')
      : null
  if (!root || !isAbsolute(root)) {
    return null
  }
  return join(root, OMNI_CONSOLE_MCP_HEADERS_HELPER_DIR, OMNI_CONSOLE_MCP_HEADERS_HELPER_FILE)
}

/**
 * The Claude `headersHelper` command for a LOCAL spawn on this machine, or null to keep the
 * legacy `headers` shape. Null on Windows (the helper is POSIX sh), for an app running from a
 * path that will not persist (translocation, AppImage mount, temp dir — see
 * isNonPersistentPath), and whenever the helper is not an executable file: a config must
 * never point at a helper that cannot run later.
 */
export function resolveOmniConsoleMcpHeadersHelperCommand(
  location: OmniConsoleMcpHeadersHelperLocation
): string | null {
  if ((location.platform ?? process.platform) === 'win32') {
    return null
  }
  const path = omniConsoleMcpHeadersHelperPath(location)
  if (!path || isNonPersistentPath(path, location.temporaryRoots ?? defaultTemporaryRoots())) {
    return null
  }
  try {
    if (!statSync(path).isFile()) {
      return null
    }
    accessSync(path, constants.X_OK)
  } catch {
    return null
  }
  return omniConsoleMcpHeadersHelperCommand(path)
}
