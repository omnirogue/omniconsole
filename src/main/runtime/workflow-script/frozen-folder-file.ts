import { createHash } from 'node:crypto'
import { link, lstat, open, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeTempFileDurable } from '../../durable-file-write'

/** A new file to publish in a folder frozen by identity (device and inode) when it was chosen. */
export type FrozenFolderFile = { root: string; fileName: string; device: string; inode: string }

async function assertOutputRoot(output: FrozenFolderFile): Promise<void> {
  const directory = await lstat(output.root, { bigint: true })
  if (
    !directory.isDirectory() ||
    String(directory.dev) !== output.device ||
    String(directory.ino) !== output.inode ||
    (await realpath(output.root)) !== output.root
  ) {
    throw new Error(`Output root changed; nothing was written to ${output.root}.`)
  }
}

async function verifyExisting(filePath: string, content: string): Promise<void> {
  const info = await lstat(filePath)
  if (!info.isFile() || info.size !== Buffer.byteLength(content)) {
    throw new Error(`Output file already exists with different content: ${filePath}`)
  }
  if ((await readFile(filePath, 'utf8')) !== content) {
    throw new Error(`Output file already exists with different content: ${filePath}`)
  }
}

/**
 * Publish a new file once into a folder frozen by identity; never replaces a different file.
 * The caller names the file; the same bytes already there count as published.
 */
export async function ensureFrozenFolderFile(
  output: FrozenFolderFile,
  content: string
): Promise<{ filePath: string; sha256: string }> {
  const filePath = join(output.root, output.fileName)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const tempPath = durableWriteTempPath(filePath)
  try {
    await assertOutputRoot(output)
    try {
      await lstat(filePath)
      await verifyExisting(filePath, content)
      return { filePath, sha256 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await writeTempFileDurable(tempPath, content, 0o600)
    await assertOutputRoot(output)
    try {
      await link(tempPath, filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      await verifyExisting(filePath, content)
    }
    try {
      const directory = await open(output.root, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      // Directory fsync is unavailable on some filesystems; the file was fsynced before link.
    }
    return { filePath, sha256 }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}
