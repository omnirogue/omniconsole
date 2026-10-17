import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  captureDirectoryRoot,
  checkRootedDirectory,
  type DirectoryRoot
} from '../filesystem-directory-chain'
import { isDescendantOrEqual } from '../ipc/filesystem-path-containment'

export async function handoffFileDestination(workspacePath: string, destination: string) {
  const workspace = resolve(workspacePath)
  const target = resolve(destination)
  if (!isDescendantOrEqual(target, workspace)) {
    throw new Error('The handoff destination is outside the selected workspace.')
  }
  const root = await captureDirectoryRoot(workspace)
  return { root, destination: resolve(root.path, relative(workspace, target)) }
}

export async function readExistingHandoffFile(
  root: DirectoryRoot,
  target: string,
  expectedSize: number
): Promise<Buffer | null> {
  if (!(await checkRootedDirectory(root, dirname(target), 'allow'))) {
    return null
  }
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!existing) {
    return null
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error('The destination is not a regular file.')
  }
  if (existing.size > Math.min(expectedSize, HANDOFF_FILE_MAX_BYTES)) {
    throw new Error('The destination already contains different work.')
  }
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== existing.dev || before.ino !== existing.ino) {
      throw new Error('The destination changed while it was read.')
    }
    const { buffer } = await readNodeFileHandleWithinLimit(
      handle,
      Math.min(expectedSize, HANDOFF_FILE_MAX_BYTES)
    )
    const after = await handle.stat()
    await checkRootedDirectory(root, dirname(target))
    const current = await lstat(target)
    if (
      current.isSymbolicLink() ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== buffer.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('The destination changed while it was read.')
    }
    return buffer
  } finally {
    await handle.close()
  }
}
