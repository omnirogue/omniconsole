import { BrowserClientDownloadTransferStore } from './browser-client-download-transfers'
import type { RuntimeFileCommands } from './omni-runtime-files'
import { isENOENT } from '../ipc/filesystem-path-containment'

type RuntimeFileChannelHost = Pick<
  RuntimeFileCommands,
  | 'captureFileExplorerTransfer'
  | 'writeFileExplorerFileBase64Chunk'
  | 'commitFileExplorerUpload'
  | 'deleteFileExplorerPath'
  | 'ensureFileExplorerDirectory'
  | 'statRuntimeFile'
>

const stores = new WeakMap<object, BrowserClientDownloadTransferStore>()

/**
 * Drops every staged download a page still owns.
 *
 * Runs on the runtime side of page retirement and lease fencing, so cleanup happens even when the
 * client transport that would have sent the abort is already gone. No-op for a runtime that never
 * opened a file channel.
 */
export function releaseBrowserClientDownloadTransfersForPage(
  runtime: object,
  browserPageId: string
): Promise<void> {
  return stores.get(runtime)?.releasePage(browserPageId) ?? Promise.resolve()
}

export function getBrowserClientDownloadTransferStore(
  runtime: RuntimeFileChannelHost
): BrowserClientDownloadTransferStore {
  let store = stores.get(runtime)
  if (!store) {
    store = new BrowserClientDownloadTransferStore(async (workspaceId) => {
      const transfer = await runtime.captureFileExplorerTransfer(workspaceId)
      const expectations = [
        transfer.expectedSshConnectionGeneration,
        transfer.expectedSshTargetId,
        transfer.expectedExecutionHostId,
        transfer
      ] as const
      return {
        writeChunk: async ({ workspaceId, relativePath, contentBase64, append }) => {
          await runtime.writeFileExplorerFileBase64Chunk(
            workspaceId,
            relativePath,
            contentBase64,
            append,
            ...expectations
          )
        },
        commit: async ({ workspaceId, tempRelativePath, finalRelativePath }) => {
          await runtime.commitFileExplorerUpload(
            workspaceId,
            tempRelativePath,
            finalRelativePath,
            ...expectations
          )
        },
        remove: async ({ workspaceId, relativePath }) => {
          await runtime.deleteFileExplorerPath(workspaceId, relativePath, false, ...expectations)
        },
        ensureDirectory: async ({ workspaceId, relativePath }) => {
          await runtime.ensureFileExplorerDirectory(workspaceId, relativePath, transfer)
        },
        exists: async ({ workspaceId, relativePath }) => {
          try {
            await runtime.statRuntimeFile(workspaceId, relativePath, transfer)
            return true
          } catch (error) {
            if (isENOENT(error)) {
              return false
            }
            throw error
          }
        }
      }
    })
    stores.set(runtime, store)
  }
  return store
}
