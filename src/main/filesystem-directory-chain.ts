import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { isDescendantOrEqual } from './ipc/filesystem-path-containment'

export type DirectoryRoot = { path: string; dev: number; ino: number }
type MissingDirectory = 'refuse' | 'allow' | 'create'

export class NonDirectoryParentError extends Error {
  constructor() {
    super('A destination parent is not a real directory.')
    this.name = 'NonDirectoryParentError'
  }
}

export async function captureDirectoryRoot(path: string): Promise<DirectoryRoot> {
  const canonical = resolve(await realpath(path))
  const metadata = await lstat(canonical)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The selected workspace is not a real directory.')
  }
  return { path: canonical, dev: metadata.dev, ino: metadata.ino }
}

/** Root aliases are resolved by the caller; every directory beneath that root must be real. */
export async function walkRealDirectoryChain(
  root: string,
  directory: string,
  missing: MissingDirectory = 'refuse'
): Promise<boolean> {
  if (!isDescendantOrEqual(directory, root)) {
    throw new Error('The destination is outside the selected workspace.')
  }
  let parent = root
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    let metadata
    try {
      metadata = await lstat(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || missing === 'refuse') {
        throw error
      }
      if (missing === 'allow') {
        return false
      }
      try {
        await mkdir(parent, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError
        }
      }
      metadata = await lstat(parent)
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new NonDirectoryParentError()
    }
  }
  return true
}

async function assertDirectoryRoot(root: DirectoryRoot): Promise<void> {
  const metadata = await lstat(root.path)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== root.dev ||
    metadata.ino !== root.ino ||
    resolve(await realpath(root.path)) !== root.path
  ) {
    throw new Error('The selected workspace changed during the transfer.')
  }
}

export async function checkRootedDirectory(
  root: DirectoryRoot,
  directory: string,
  missing: MissingDirectory = 'refuse'
): Promise<boolean> {
  await assertDirectoryRoot(root)
  const exists = await walkRealDirectoryChain(root.path, directory, missing)
  await assertDirectoryRoot(root)
  return exists
}
