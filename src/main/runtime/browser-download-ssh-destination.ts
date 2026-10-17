import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY } from './browser-client-download-transfers'
import {
  assertSameTransferFile,
  browserDownloadRelativePath,
  type BrowserDownloadDestination
} from './browser-download-destination'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

function assertSameDirectory(expected: FileStat, actual: FileStat): void {
  if (
    actual.type !== 'directory' ||
    (expected.dev !== undefined && actual.dev !== expected.dev) ||
    (expected.ino !== undefined && actual.ino !== expected.ino)
  ) {
    throw new Error('The remote download folder changed during the transfer.')
  }
}

export async function captureSshBrowserDownloadDestination(
  workspacePath: string,
  provider: IFilesystemProvider,
  assertOwner: () => Promise<void>
): Promise<BrowserDownloadDestination> {
  if (
    !provider.lstat ||
    !provider.realpath ||
    !provider.createDirNoClobber ||
    !provider.renameNoClobber
  ) {
    throw new Error(
      'Safe remote downloads are unavailable. Reconnect the SSH target and try again.'
    )
  }
  const inspect = provider.lstat.bind(provider)
  await assertOwner()
  const root = await provider.realpath(workspacePath)
  const rootIdentity = await inspect(root)
  assertSameDirectory(rootIdentity, rootIdentity)
  const directory = joinWorktreeRelativePath(root, BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY)
  let directoryIdentity: FileStat | undefined
  const owned = new Map<string, FileStat>()
  const path = (relativePath: string) =>
    joinWorktreeRelativePath(root, browserDownloadRelativePath(relativePath))
  const samePath = (left: string, right: string) =>
    normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
  const check = async (create = false) => {
    await assertOwner()
    assertSameDirectory(rootIdentity, await inspect(root))
    if (!samePath(await provider.realpath(root), root)) {
      throw new Error('The remote workspace changed during the transfer.')
    }
    let current = root
    for (const part of BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY.split('/')) {
      current = joinWorktreeRelativePath(current, part)
      let metadata
      try {
        metadata = await inspect(current)
      } catch (error) {
        if (!create || !isENOENT(error)) {
          throw error
        }
        await assertOwner()
        try {
          await provider.createDirNoClobber(current)
        } catch (createError) {
          if (
            !(createError instanceof Error) ||
            !/\bEEXIST\b|already exists/i.test(createError.message)
          ) {
            throw createError
          }
        }
        metadata = await inspect(current)
      }
      if (metadata.type !== 'directory' || !samePath(await provider.realpath(current), current)) {
        throw new Error('A remote download parent is not a real directory.')
      }
    }
    const currentDirectory = await inspect(directory)
    if (directoryIdentity) {
      assertSameDirectory(directoryIdentity, currentDirectory)
    } else if (create) {
      directoryIdentity = currentDirectory
    } else {
      throw new Error('The download folder has not been prepared.')
    }
    await assertOwner()
  }
  const statOwned = async (relativePath: string) => {
    const expected = owned.get(relativePath)
    if (!expected) {
      throw new Error('This transfer does not own the staged download.')
    }
    assertSameTransferFile(expected, await inspect(path(relativePath)))
    return expected
  }
  return {
    ensureDirectory: async (relativePath) => {
      browserDownloadRelativePath(relativePath, true)
      await check(true)
    },
    writeChunk: async (relativePath, contentBase64, append) => {
      await check()
      const expected = append ? await statOwned(relativePath) : null
      await assertOwner()
      await provider.writeFileBase64Chunk(path(relativePath), contentBase64, append)
      await check()
      const current = await inspect(path(relativePath))
      if (
        current.type !== 'file' ||
        current.size !== (expected?.size ?? 0) + Buffer.from(contentBase64, 'base64').length
      ) {
        throw new Error('The staged remote download changed during the transfer.')
      }
      if (expected) {
        assertSameTransferFile({ ...expected, size: current.size }, current)
      }
      owned.set(relativePath, current)
    },
    commit: async (tempRelativePath, finalRelativePath) => {
      await check()
      const expected = await statOwned(tempRelativePath)
      await assertOwner()
      await provider.renameNoClobber(path(tempRelativePath), path(finalRelativePath))
      await check()
      assertSameTransferFile(expected, await inspect(path(finalRelativePath)))
      owned.delete(tempRelativePath)
    },
    remove: async (relativePath) => {
      if (!owned.has(relativePath)) {
        return
      }
      await check()
      await statOwned(relativePath)
      await assertOwner()
      await provider.deletePath(path(relativePath), false)
      owned.delete(relativePath)
    },
    stat: async (relativePath) => {
      await check()
      return inspect(path(relativePath))
    }
  }
}
