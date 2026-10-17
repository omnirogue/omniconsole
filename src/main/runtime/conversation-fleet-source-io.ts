import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { FileExactReadIdentity } from '../../shared/exact-file-read-identity'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import { isMethodNotFoundError } from '../ssh/ssh-file-stream-contract'

export type SourceStat = {
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  ctimeMs?: number
  ino?: number
  dev?: number
  mode?: number
}

export type FleetSourceIo = {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<SourceStat>
  readExact(path: string, maxBytes: number, expected?: SourceStat): Promise<Buffer>
}

const REMOTE_UPDATE_REQUIRED =
  'Safe source snapshots require an updated remote host. Update Orca, reconnect the SSH target, and retry.'
const SOURCE_CHANGED = 'The source changed while reading. Refresh the dispatch preview and retry.'

function pathApi(root: string): typeof posix {
  return isWindowsAbsolutePathLike(root) ? win32 : posix
}

function samePath(left: string, right: string): boolean {
  return pathApi(left).relative(left, right) === ''
}

function sourceType(mode: number): SourceStat['type'] {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFREG:
      return 'file'
    case constants.S_IFDIR:
      return 'directory'
    case constants.S_IFLNK:
      return 'symlink'
    default:
      return 'other'
  }
}

function localSourceStat(stats: Stats): SourceStat {
  return {
    type: sourceType(stats.mode),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    dev: stats.dev,
    mode: stats.mode
  }
}

function exactIdentity(stats: SourceStat): FileExactReadIdentity {
  const { size, dev, ino, mode, mtimeMs, ctimeMs } = stats
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof dev !== 'number' ||
    !Number.isSafeInteger(dev) ||
    dev < 0 ||
    typeof ino !== 'number' ||
    !Number.isSafeInteger(ino) ||
    ino < 0 ||
    typeof mode !== 'number' ||
    !Number.isSafeInteger(mode) ||
    mode < 0 ||
    !Number.isFinite(mtimeMs) ||
    typeof ctimeMs !== 'number' ||
    !Number.isFinite(ctimeMs)
  ) {
    throw new Error('The source host did not provide complete file identity and executable mode.')
  }
  return { size, dev, ino, mode, mtimeMs, ctimeMs }
}

function assertUnchanged(expected: SourceStat, actual: SourceStat): void {
  if (
    expected.type !== actual.type ||
    expected.size !== actual.size ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.mode !== actual.mode ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs
  ) {
    throw new Error(SOURCE_CHANGED)
  }
}

function assertReadable(stats: SourceStat, maxBytes: number): void {
  exactIdentity(stats)
  if (stats.type !== 'file') {
    throw new Error('Source snapshots require regular files.')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('The source file byte limit must be a non-negative safe integer.')
  }
  if (stats.size > maxBytes) {
    throw new Error(`Source file exceeds the ${maxBytes} byte limit.`)
  }
}

async function readLocalExact(
  filePath: string,
  maxBytes: number,
  expected?: SourceStat
): Promise<Buffer> {
  const before = localSourceStat(await lstat(filePath))
  assertReadable(before, maxBytes)
  if (expected) {
    assertUnchanged(expected, before)
  }
  if (!samePath(filePath, await realpath(filePath))) {
    throw new Error(SOURCE_CHANGED)
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
  )
  try {
    assertUnchanged(before, localSourceStat(await handle.stat()))
    const { buffer } = await readNodeFileHandleWithinLimit(handle, maxBytes)
    assertUnchanged(before, localSourceStat(await handle.stat()))
    assertUnchanged(before, localSourceStat(await lstat(filePath)))
    if (buffer.length !== before.size || !samePath(filePath, await realpath(filePath))) {
      throw new Error(SOURCE_CHANGED)
    }
    return buffer
  } finally {
    await handle.close()
  }
}

function remoteSourceStat(stats: FileStat): SourceStat {
  if (stats.exactReadIdentity !== 1 || stats.mode === undefined || stats.mtimeMs === undefined) {
    throw new Error(REMOTE_UPDATE_REQUIRED)
  }
  const result = { ...stats, type: sourceType(stats.mode), mtimeMs: stats.mtimeMs }
  try {
    exactIdentity(result)
  } catch {
    throw new Error(REMOTE_UPDATE_REQUIRED)
  }
  return result
}

function remoteSourceIo(connectionId: string): FleetSourceIo {
  const originalProvider = requireSshFilesystemProvider(connectionId)
  const provider = (): IFilesystemProvider => {
    const current = requireSshFilesystemProvider(connectionId)
    if (current !== originalProvider) {
      throw new Error(SOURCE_CHANGED)
    }
    return current
  }
  const io: FleetSourceIo = {
    realpath: (filePath) => provider().realpath(filePath),
    lstat: async (filePath) => {
      const current = provider()
      if (!current.lstat) {
        throw new Error(REMOTE_UPDATE_REQUIRED)
      }
      try {
        return remoteSourceStat(await current.lstat(filePath))
      } catch (error) {
        if (
          isMethodNotFoundError(error) ||
          (error instanceof Error && error.message === 'remote_lstat_unavailable')
        ) {
          throw new Error(REMOTE_UPDATE_REQUIRED)
        }
        throw error
      }
    },
    readExact: async (filePath, maxBytes, expected) => {
      const before = await io.lstat(filePath)
      assertReadable(before, maxBytes)
      if (expected) {
        assertUnchanged(expected, before)
      }
      if (!samePath(filePath, await io.realpath(filePath))) {
        throw new Error(SOURCE_CHANGED)
      }
      const current = provider()
      if (!current.readExactFile) {
        throw new Error(REMOTE_UPDATE_REQUIRED)
      }
      let result
      try {
        result = await current.readExactFile(filePath, maxBytes, exactIdentity(before))
      } catch (error) {
        if (isMethodNotFoundError(error)) {
          throw new Error(REMOTE_UPDATE_REQUIRED)
        }
        throw error
      }
      if (!result.isBinary || typeof result.content !== 'string') {
        throw new Error('The source host did not return exact binary file bytes.')
      }
      if (result.content.length > 4 * Math.ceil(maxBytes / 3)) {
        throw new Error(`Source file exceeds the ${maxBytes} byte limit.`)
      }
      const bytes = Buffer.from(result.content, 'base64')
      if (bytes.toString('base64') !== result.content || bytes.length !== before.size) {
        throw new Error('The source host returned incomplete or invalid file bytes.')
      }
      assertUnchanged(before, await io.lstat(filePath))
      if (!samePath(filePath, await io.realpath(filePath))) {
        throw new Error(SOURCE_CHANGED)
      }
      return bytes
    }
  }
  return io
}

export function createFleetSourceIo(connectionId?: string): FleetSourceIo {
  if (connectionId !== undefined) {
    if (!connectionId.trim()) {
      throw new Error('Choose a valid SSH source connection.')
    }
    return remoteSourceIo(connectionId)
  }
  return {
    realpath,
    lstat: async (filePath) => localSourceStat(await lstat(filePath)),
    readExact: readLocalExact
  }
}

export async function assertFleetSourcePath(
  io: FleetSourceIo,
  root: string,
  relativePath: string,
  allowMissing = false
): Promise<string> {
  const api = pathApi(root)
  const parts = relativePath.split(api === win32 ? /[\\/]/ : '/')
  if (
    !api.isAbsolute(root) ||
    !relativePath ||
    relativePath.includes('\0') ||
    api.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    parts.some(
      (part) => !part || part === '.' || part === '..' || (api === win32 && part.includes(':'))
    )
  ) {
    throw new Error('Invalid source path: select a file inside the worktree.')
  }
  const rootStat = await io.lstat(root)
  if (rootStat.type !== 'directory' || !samePath(root, await io.realpath(root))) {
    throw new Error('The source worktree root changed. Refresh the dispatch preview and retry.')
  }
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = api.join(current, parts[index]!)
    let stats: SourceStat
    try {
      stats = await io.lstat(current)
    } catch (error) {
      if (allowMissing && isENOENT(error)) {
        current = api.join(root, ...parts)
        break
      }
      throw error
    }
    if (stats.type === 'symlink') {
      throw new Error(`Source path contains a symlink: ${relativePath}`)
    }
    if (stats.type === 'other') {
      throw new Error(`Source path is not a regular file: ${relativePath}`)
    }
    if (index < parts.length - 1 && stats.type !== 'directory') {
      throw new Error(`Source parent is not a directory: ${relativePath}`)
    }
    if (!samePath(current, await io.realpath(current))) {
      throw new Error(SOURCE_CHANGED)
    }
  }
  assertUnchanged(rootStat, await io.lstat(root))
  return current
}
