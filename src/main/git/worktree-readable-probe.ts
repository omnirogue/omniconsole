import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WORKTREE_METADATA_MAX_PATH_BYTES } from './worktree-metadata-protocol'

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

// Child-only: every filesystem operation here may be uninterruptible at the OS boundary.
async function readRegularFile(
  path: string,
  maxBytes: number,
  complete = false
): Promise<Buffer | undefined> {
  if (!(await lstat(path)).isFile()) {
    return undefined
  }
  const handle = await open(path, READ_FLAGS)
  try {
    if (!(await handle.stat()).isFile()) {
      return undefined
    }
    const buffer = Buffer.alloc(maxBytes)
    let total = 0
    do {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) {
        break
      }
      total += bytesRead
    } while (complete && total < buffer.length)
    return total > 0 ? buffer.subarray(0, total) : undefined
  } finally {
    await handle.close()
  }
}

export async function probeWorktreeReadable(root: string): Promise<boolean> {
  try {
    const directory = await opendir(root, { bufferSize: 1 })
    try {
      await directory.read()
    } finally {
      await directory.close()
    }
    const marker = join(root, '.git')
    let markerType: Awaited<ReturnType<typeof lstat>>
    try {
      markerType = await lstat(marker)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return code === 'ENOENT' || code === 'ENOTDIR'
    }
    if (markerType.isDirectory()) {
      return (await readRegularFile(join(marker, 'HEAD'), 1)) !== undefined
    }
    if (!markerType.isFile()) {
      return false
    }
    const contents = await readRegularFile(marker, WORKTREE_METADATA_MAX_PATH_BYTES + 1, true)
    if (!contents || contents.length > WORKTREE_METADATA_MAX_PATH_BYTES) {
      return false
    }
    const match = contents.toString('utf8').match(/^gitdir:\s*(.+)\s*$/m)
    if (!match) {
      return true
    }
    return (await readRegularFile(join(resolve(root, match[1]), 'HEAD'), 1)) !== undefined
  } catch {
    return false
  }
}
