import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'

/** Larger files are not hashed: the outcome verifier refuses them, the deliverable check counts them. */
export const DELIVERED_FILE_MAX_BYTES = 64 * 1024 * 1024

export type DeliveredFileReading =
  | { status: 'file'; path: string; hash: string; size: number; mtimeMs: number }
  | {
      status: 'not-file' | 'too-large'
      path: string
      size: number
      mtimeMs: number
      isDirectory: boolean
    }
  /** `code` is the filesystem's (`ENOENT` = nothing there); anything else observed nothing. */
  | { status: 'unreadable'; code?: string }

/** One file on THIS host, read the way delivery proof reads it: real path, regular file, hash. */
export async function readDeliveredFile(path: string): Promise<DeliveredFileReading> {
  try {
    const real = await realpath(path)
    const info = await stat(real)
    if (!info.isFile() || info.size > DELIVERED_FILE_MAX_BYTES) {
      return {
        status: info.isFile() ? 'too-large' : 'not-file',
        path: real,
        size: info.size,
        mtimeMs: info.mtimeMs,
        isDirectory: info.isDirectory()
      }
    }
    const hash = createHash('sha256')
      .update(await readFile(real))
      .digest('hex')
    return { status: 'file', path: real, hash, size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { status: 'unreadable', ...(typeof code === 'string' ? { code } : {}) }
  }
}
