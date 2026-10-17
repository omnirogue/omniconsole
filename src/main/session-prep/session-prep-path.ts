import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, sep, posix, win32 } from 'node:path'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { SessionPrepHostError } from './session-prep-execution-host'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * True when `rel` names a file under `cwd`, or is an absolute path to a file inside the person's
 * home folder (a document on their Desktop, another repository). `..` segments are refused.
 */
export async function sessionPrepPathExists(
  cwd: string,
  rel: string,
  connectionId?: string
): Promise<boolean> {
  const trimmed = rel.trim()
  const parts = trimmed.split(/[\\/]/)
  if (!trimmed || parts.some((part) => part === '..')) {
    return false
  }
  if (connectionId) {
    // Why: the controller's home directory and path separator say nothing about the SSH host.
    const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? win32 : posix
    const provider = requireSshFilesystemProvider(connectionId)
    const candidate = paths.isAbsolute(trimmed) ? trimmed : paths.join(cwd, parts.join(paths.sep))
    if (paths.isAbsolute(trimmed)) {
      const home = await provider.getHomeDir?.()
      if (!home || !paths.isAbsolute(home)) {
        throw new SessionPrepHostError('Cannot verify the home directory on the SSH host.')
      }
      const inside = paths.relative(home, candidate)
      if (paths.isAbsolute(inside) || inside === '..' || inside.startsWith(`..${paths.sep}`)) {
        return false
      }
    }
    try {
      await provider.stat(candidate)
      return true
    } catch (error) {
      // A missing reference is repairable; loss of the execution host must stop preparation.
      if (/ENOENT|ENOTDIR|no such file or directory/i.test(String(error))) {
        return false
      }
      throw new SessionPrepHostError(
        'Cannot read references on the SSH host. Reconnect before retrying.'
      )
    }
  }
  if (isAbsolute(trimmed)) {
    const home = homedir()
    return normalize(trimmed).startsWith(home.endsWith(sep) ? home : home + sep) && exists(trimmed)
  }
  return exists(join(cwd, parts.join(sep)))
}
