import { moveSessionToFolder, type SessionFolderMetadata } from './session-folders'

/** Same metadata object means a confirmed replay; null means an operation-id collision. */
export function transferFolderPlacement(
  before: SessionFolderMetadata,
  sessionKey: string,
  folderId: string | null,
  operationId: string
): SessionFolderMetadata | null {
  const prior = before.transferReceipts?.[operationId]
  if (prior) {
    return prior.sessionKey === sessionKey && prior.folderId === folderId ? before : null
  }
  const metadata = moveSessionToFolder(before, sessionKey, folderId)
  const recent = Object.entries(metadata.transferReceipts ?? {}).filter(
    ([, receipt]) => receipt.at > Date.now() - 86_400_000
  )
  return {
    ...metadata,
    transferReceipts: {
      ...Object.fromEntries(recent),
      [operationId]: { sessionKey, folderId, at: Date.now() }
    }
  }
}
