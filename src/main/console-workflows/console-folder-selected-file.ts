import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { ConsoleArtifactEvidenceError } from './console-folder-job-result'
import { NonDirectoryParentError, walkRealDirectoryChain } from '../filesystem-directory-chain'

function selectedPath(root: string, path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
  ) {
    throw new Error('A selected folder output path is invalid.')
  }
  const absolute = resolve(root, ...path.split('/'))
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error('A selected folder output path escapes its workspace.')
  }
  return absolute
}

/** Bind selected output bytes to one regular file handle after rejecting symlinked parents. */
export async function readConsoleFolderSelectedFile(
  root: string,
  path: string
): Promise<{ content: Buffer; mode: number }> {
  const absolute = selectedPath(root, path)
  try {
    await walkRealDirectoryChain(root, dirname(absolute))
  } catch (error) {
    if (error instanceof NonDirectoryParentError) {
      throw new ConsoleArtifactEvidenceError('A folder snapshot parent is not a real directory.')
    }
    throw error
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 65_536) {
      throw new ConsoleArtifactEvidenceError(
        'A selected folder output is not a bounded regular file.'
      )
    }
    const content = await handle.readFile()
    const after = await handle.stat()
    const current = await lstat(absolute)
    if (
      current.isSymbolicLink() ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== content.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new ConsoleArtifactEvidenceError(
        'A selected folder output changed while it was captured.'
      )
    }
    return { content, mode: before.mode & 0o777 }
  } finally {
    await handle.close()
  }
}
