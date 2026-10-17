import type { ExecutionHostId } from '../../shared/execution-host'
import type { FileStat } from '../providers/types'
import { BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY } from './browser-client-download-transfers'
import { normalizeRuntimeRelativePath } from './runtime-relative-paths'

export type BrowserDownloadDestination = {
  ensureDirectory(relativePath: string): Promise<void>
  writeChunk(relativePath: string, contentBase64: string, append: boolean): Promise<void>
  commit(tempRelativePath: string, finalRelativePath: string): Promise<void>
  remove(relativePath: string): Promise<void>
  stat(relativePath: string): Promise<FileStat>
}

export type RuntimeFileTransferContext = {
  worktreeId: string
  workspacePath: string
  expectedExecutionHostId: ExecutionHostId
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  assertOwner(): Promise<void>
  destination: BrowserDownloadDestination
}

export function browserDownloadRelativePath(path: string, directory = false): string {
  const normalized = normalizeRuntimeRelativePath(path)
  const root = BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY
  if (
    normalized.includes('\0') ||
    (directory
      ? normalized !== root
      : !normalized.startsWith(`${root}/`) || normalized.slice(root.length + 1).includes('/'))
  ) {
    throw new Error('The download destination is outside its workspace folder.')
  }
  return normalized
}

export function assertSameTransferFile(expected: FileStat, current: FileStat): void {
  if (
    current.type !== 'file' ||
    current.size !== expected.size ||
    (expected.dev !== undefined && current.dev !== expected.dev) ||
    (expected.ino !== undefined && current.ino !== expected.ino)
  ) {
    throw new Error('The staged download changed during the transfer.')
  }
}
