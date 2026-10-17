import { constants, type Stats } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  captureDirectoryRoot,
  checkRootedDirectory,
  type DirectoryRoot
} from '../filesystem-directory-chain'
import type { FileStat } from '../providers/types'
import { BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY } from './browser-client-download-transfers'
import {
  assertSameTransferFile,
  browserDownloadRelativePath,
  type BrowserDownloadDestination
} from './browser-download-destination'

function fileStat(value: Stats): FileStat {
  return {
    type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'file',
    size: value.size,
    mtime: value.mtimeMs,
    dev: value.dev,
    ino: value.ino
  }
}

export async function captureNativeBrowserDownloadDestination(
  workspacePath: string,
  assertOwner: () => Promise<void>
): Promise<BrowserDownloadDestination> {
  const root = await captureDirectoryRoot(workspacePath)
  const directoryPath = join(root.path, BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY)
  const owned = new Map<string, FileStat>()
  let directory: DirectoryRoot | undefined
  const path = (relativePath: string) => join(root.path, browserDownloadRelativePath(relativePath))
  const check = async () => {
    await assertOwner()
    await checkRootedDirectory(root, directoryPath)
    if (!directory) {
      throw new Error('The download folder has not been prepared.')
    }
    await checkRootedDirectory(directory, directory.path)
    await assertOwner()
  }
  const statOwned = async (relativePath: string): Promise<FileStat> => {
    const expected = owned.get(relativePath)
    if (!expected) {
      throw new Error('This transfer does not own the staged download.')
    }
    const current = fileStat(await lstat(path(relativePath)))
    assertSameTransferFile(expected, current)
    return current
  }
  return {
    ensureDirectory: async (relativePath) => {
      browserDownloadRelativePath(relativePath, true)
      await assertOwner()
      await checkRootedDirectory(root, directoryPath, 'create')
      directory ??= await captureDirectoryRoot(directoryPath)
      await check()
    },
    writeChunk: async (relativePath, contentBase64, append) => {
      await check()
      const expected = append ? await statOwned(relativePath) : null
      const flags =
        constants.O_WRONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0) |
        (append ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL)
      const handle = await open(path(relativePath), flags, 0o600)
      try {
        const before = await handle.stat()
        if (!before.isFile()) {
          throw new Error('The staged download is not a regular file.')
        }
        if (expected) {
          assertSameTransferFile(expected, fileStat(before))
        }
        owned.set(relativePath, fileStat(before))
        await assertOwner()
        const content = Buffer.from(contentBase64, 'base64')
        await handle.writeFile(content)
        const after = await handle.stat()
        owned.set(relativePath, fileStat(after))
        if (after.size !== before.size + content.length) {
          throw new Error('The staged download size changed during the transfer.')
        }
      } finally {
        await handle.close()
      }
      await check()
      await statOwned(relativePath)
    },
    commit: async (tempRelativePath, finalRelativePath) => {
      await check()
      const expected = await statOwned(tempRelativePath)
      await assertOwner()
      await link(path(tempRelativePath), path(finalRelativePath))
      await check()
      assertSameTransferFile(expected, fileStat(await lstat(path(finalRelativePath))))
      await statOwned(tempRelativePath)
      await unlink(path(tempRelativePath))
      owned.delete(tempRelativePath)
    },
    remove: async (relativePath) => {
      if (!owned.has(relativePath)) {
        return
      }
      await check()
      await statOwned(relativePath)
      await unlink(path(relativePath))
      owned.delete(relativePath)
    },
    stat: async (relativePath) => {
      await check()
      return fileStat(await lstat(path(relativePath)))
    }
  }
}
