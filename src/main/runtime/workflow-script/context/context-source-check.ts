import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import {
  workflowCredentialPaths,
  workflowHomeFolder,
  workflowPathWithin,
  workflowRootContainsHome
} from '../local-workflow-read-scope'
import { workflowContextCredentialName } from './context-exclusions'

/** `~` and `~/…` spelled from the home folder; every other path as written. */
export function workflowExpandHome(path: string, home: string): string {
  if (path === '~') {
    return home
  }
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path
}

/**
 * Where logins and keys live beyond the credential names: all of ~/Library on macOS and
 * ~/AppData on Windows (keychains, cookies, app sign-ins) and this app's own data folder.
 */
export function workflowContextRefusedRoots(home: string, appData?: string): string[] {
  return [
    ...(process.platform === 'darwin' ? [join(home, 'Library')] : []),
    ...(process.platform === 'win32' ? [join(home, 'AppData')] : []),
    ...(appData ? [appData] : [])
  ]
}

/**
 * The canonical path of one chosen file or folder, or a plain-English refusal: a missing path, a
 * folder that holds the home folder, or anything that is or sits inside a credential location.
 */
export async function assertWorkflowContextPath(
  path: string,
  options: { home?: string; appData?: string } = {}
): Promise<{ path: string; directory: boolean }> {
  const home = options.home ?? workflowHomeFolder()
  const written = workflowExpandHome(path, home)
  if (!isAbsolute(written)) {
    throw new Error(`${path} is not a full path. Choose the file or folder again.`)
  }
  let canonical: string
  try {
    canonical = await realpath(written)
  } catch {
    throw new Error(`${path} can't be found. Choose the file or folder again.`)
  }
  if (await workflowRootContainsHome(canonical, home)) {
    throw new Error(
      `Agents can't read ${path}: it contains your home folder, where logins and keys live. Choose the project folders or files inside it instead.`
    )
  }
  const credentials = [
    ...(await workflowCredentialPaths(home)),
    ...workflowContextRefusedRoots(home, options.appData)
  ]
  if (
    credentials.some((location) => workflowPathWithin(canonical, location)) ||
    canonical.split(sep).some(workflowContextCredentialName)
  ) {
    throw new Error(
      `Agents can't read ${path}: it is where logins, keys or app data are kept. Choose your project files instead.`
    )
  }
  const info = await lstat(canonical)
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error(`${path} is not a file or folder.`)
  }
  return { path: canonical, directory: info.isDirectory() }
}
