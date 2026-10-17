// Why: rename() is atomic for readers but not durable. Without fsync on the file and its directory,
// a power loss after a successful rename can leave the old contents, or an empty inode — the same
// empty-file symptom as issue #1158, from a different cause. The .bak ring recovers it at up to an
// hour's loss; fsync stops it from happening.

import { closeSync, fsyncSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { renameFileWithWindowsRetry } from './codex-accounts/fs-utils'

/**
 * fsync a directory so a rename within it is durable. Best-effort by design: Windows cannot open a
 * directory for fsync, and some filesystems reject it. The file fsync above it is the load-bearing
 * part; this closes the "rename recorded but not persisted" window where the platform allows it.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Expected on Windows and on filesystems without directory fsync.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The codes a POSIX filesystem uses to say it has no fsync for directories. */
const DIRECTORY_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

export type DirectorySyncStep = 'open' | 'fsync'

/**
 * Whether a directory-sync error means "this platform or filesystem cannot fsync a directory"
 * rather than "the sync failed". Opening the directory for reading works everywhere, so a
 * failed open (EIO, ENOENT, EACCES, EPERM) is a real failure on every platform. The flush is
 * the step with platform limits: Windows flushes a directory handle only with write access,
 * which a read handle never has, so its flush failure is expected and the file fsync stays the
 * load-bearing part; elsewhere only the filesystem's own "no directory fsync" answer counts,
 * and a permission denial, EIO, ENOSPC or EROFS is a real durability failure.
 */
export function isDirectorySyncUnsupported(
  error: unknown,
  step: DirectorySyncStep,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (step === 'open') {
    return false
  }
  if (platform === 'win32') {
    return true
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code !== undefined && DIRECTORY_FSYNC_UNSUPPORTED.has(code)
}

export type DurableWriteOptions = {
  /**
   * Surface a genuine directory-sync failure instead of swallowing it. For a write that is a
   * barrier (work must not start unless the record is durable); the default stays best-effort.
   */
  strictDirectorySync?: boolean
}

export function syncDirectorySync(directory: string, options: DurableWriteOptions = {}): void {
  let fd: number | null = null
  let step: DirectorySyncStep = 'open'
  try {
    fd = openSync(directory, 'r')
    step = 'fsync'
    fsyncSync(fd)
  } catch (error) {
    // Same platform caveats as syncDirectory; a strict caller still hears a real failure.
    if (options.strictDirectorySync && !isDirectorySyncUnsupported(error, step)) {
      throw error
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Nothing actionable; the fsync already happened or the open failed.
      }
    }
  }
}

/**
 * Rename and then fsync the containing directory. For callers that already fsynced the temp file
 * themselves and need the rename made durable.
 */
export async function renameDurable(tmpPath: string, finalPath: string): Promise<void> {
  await rename(tmpPath, finalPath)
  await syncDirectory(dirname(finalPath))
}

/**
 * Write `payload` to `tmpPath` and fsync it, WITHOUT publishing it. For callers that must order
 * other work between "the new content is durable" and "the new content is visible" — a backup
 * rotation that has to happen while the old file is still in place, for instance.
 */
export async function writeTempFileDurable(
  tmpPath: string,
  payload: string,
  mode?: number
): Promise<void> {
  const handle = await open(tmpPath, 'w', mode)
  try {
    await handle.writeFile(payload, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Copy `sourcePath` onto `finalPath` durably: a fresh inode, fsynced, then renamed into place. A
 * plain copyFile can be interrupted and leave a torn destination — fatal when the destination is
 * the backup someone will fall back to. Returns false when the source does not exist.
 */
export async function copyFileDurable(sourcePath: string, finalPath: string): Promise<boolean> {
  const tmpPath = durableWriteTempPath(finalPath)
  let renamed = false
  try {
    try {
      // copyFile stays in the kernel — and clones the extents outright on APFS and btrfs — so
      // this does not pull the whole file through the process on every commit.
      await copyFile(sourcePath, tmpPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
    const handle = await open(tmpPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, finalPath)
    renamed = true
    await syncDirectory(dirname(finalPath))
    return true
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

/** Write `payload` to `tmpPath`, fsync it, then rename onto `finalPath` and fsync the directory. */
export async function writeFileDurable(
  tmpPath: string,
  finalPath: string,
  payload: string
): Promise<void> {
  await writeFileDurableIfCurrent(tmpPath, finalPath, payload, () => true)
}

/**
 * `writeFileDurable` with a commit veto: `isCurrent` is consulted after the fsync and before the
 * rename so a writer that was superseded mid-write doesn't publish a stale snapshot. Returns whether
 * the rename happened; the temp file is removed on every path that doesn't commit, so a multi-MB
 * payload can't orphan itself.
 */
export async function writeFileDurableIfCurrent(
  tmpPath: string,
  finalPath: string,
  payload: string,
  isCurrent: () => boolean
): Promise<boolean> {
  let renamed = false
  try {
    // Why: fsync BEFORE rename. A rename that lands first can expose a zero-length file.
    await writeTempFileDurable(tmpPath, payload)
    if (!isCurrent()) {
      return false
    }
    await rename(tmpPath, finalPath)
    renamed = true
    await syncDirectory(dirname(finalPath))
    return true
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}

/** Temp path for a durable write. Shared shape so `removeStaleDurableWriteTempFiles` can reclaim orphans. */
export function durableWriteTempPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
}

/**
 * Sweep temp files orphaned by a death between write and rename — for multi-MB payloads they would
 * otherwise accumulate forever. Callers can require a minimum age to spare another live instance's
 * write. This process's own temps are always skipped because deleting one would fail its rename.
 */
export async function removeStaleDurableWriteTempFiles(
  finalPath: string,
  options: { minimumAgeMs?: number } = {}
): Promise<void> {
  const directory = dirname(finalPath)
  const prefix = `${basename(finalPath)}.`
  const ownPrefix = `${prefix}${process.pid}.`
  try {
    const names = await readdir(directory)
    await Promise.all(
      names
        .filter(
          (name) => name.startsWith(prefix) && name.endsWith('.tmp') && !name.startsWith(ownPrefix)
        )
        .map(async (name) => {
          const path = join(directory, name)
          if (options.minimumAgeMs) {
            const info = await stat(path).catch(() => null)
            if (!info || Date.now() - info.mtimeMs < options.minimumAgeMs) {
              return
            }
          }
          await rm(path, { force: true }).catch(() => {})
        })
    )
  } catch {
    // Directory missing or unreadable — nothing to sweep.
  }
}

/** Synchronous counterpart for quit and crash paths that cannot await. */
export function writeFileDurableSync(
  tmpPath: string,
  finalPath: string,
  payload: string,
  options: DurableWriteOptions = {}
): void {
  let renamed = false
  try {
    writeFileSync(tmpPath, payload, 'utf-8')
    const fd = openSync(tmpPath, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameFileWithWindowsRetry(tmpPath, finalPath)
    renamed = true
    syncDirectorySync(dirname(finalPath), options)
  } finally {
    if (!renamed) {
      rmSync(tmpPath, { force: true })
    }
  }
}
