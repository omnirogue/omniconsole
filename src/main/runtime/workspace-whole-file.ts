import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/** Larger files are never read whole: a quote's absence in them is not proven. */
export const WORKSPACE_WHOLE_FILE_MAX_BYTES = 8 * 1024 * 1024

/** A path the evidence names, resolved inside the workspace; null when it would leave it. */
export async function resolveInsideWorkspace(root: string, file: string): Promise<string | null> {
  try {
    const target = await realpath(resolve(root, file))
    const base = await realpath(root)
    const rel = relative(base, target)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? target : null
  } catch {
    return null
  }
}

/** The whole file as text, or null when it cannot be read in full (missing, a directory, too big). */
export async function readWorkspaceWholeFile(root: string, file: string): Promise<string | null> {
  const path = await resolveInsideWorkspace(root, file)
  if (!path) {
    return null
  }
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > WORKSPACE_WHOLE_FILE_MAX_BYTES) {
      return null
    }
    return (await readFile(path)).toString('utf8')
  } catch {
    return null
  }
}
