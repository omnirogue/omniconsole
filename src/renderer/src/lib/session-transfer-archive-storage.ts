import { setSessionArchivedAt, type SessionSidebarView } from './session-sidebar-view'
import type { SessionSidebarViewStorage } from './session-sidebar-view-storage'
import type { TransferArchiveProjection } from '../../../shared/session-folder-cli-channels'

type ProjectionApi = {
  pendingSessionTransferArchives(scope: string): TransferArchiveProjection[] | null
  acknowledgeSessionTransferArchive(scope: string, operationId: string): boolean
}
const projectionApi = (): ProjectionApi | undefined =>
  typeof window === 'undefined' ? undefined : window.api?.ui

export function readTransferArchiveReceipt(
  storage: SessionSidebarViewStorage,
  id: string
): readonly string[] | null {
  const view = storage.load()
  const keys = view.transferArchiveReceipts?.[id]
  return keys && keys.every((key) => view.archived?.includes(key)) ? keys : null
}

function project(
  storage: SessionSidebarViewStorage,
  view: SessionSidebarView,
  keys: readonly string[],
  operationId: string
): SessionSidebarView {
  const next = {
    ...setSessionArchivedAt(view, keys, true, Date.now()),
    archived: [...new Set([...(view.archived ?? []), ...keys])],
    // Keep receipts after Undo and until main acknowledges them, including missed IPC replies.
    transferArchiveReceipts: { ...view.transferArchiveReceipts, [operationId]: [...keys] }
  }
  storage.save(next)
  if (JSON.stringify(readTransferArchiveReceipt(storage, operationId)) !== JSON.stringify(keys)) {
    throw new Error('The source archive could not be confirmed in persistent storage.')
  }
  return next
}

function acknowledge(
  storage: SessionSidebarViewStorage,
  operationId: string,
  api = projectionApi()
): void {
  const scope = storage.projectionScope?.()
  if (!scope || !api?.acknowledgeSessionTransferArchive) {
    return
  }
  try {
    api.acknowledgeSessionTransferArchive(scope, operationId)
  } catch {
    /* Recover from the saved receipt on reload. */
  }
}

/** Main has already committed under its source fences; this single save projects its decision. */
export function persistTransferArchive(
  storage: SessionSidebarViewStorage,
  view: SessionSidebarView,
  keys: readonly string[],
  operationId: string,
  commit: () => boolean
): SessionSidebarView {
  if (!operationId || !keys.length || new Set(keys).size !== keys.length) {
    throw new Error('The archive operation requires unique source identities.')
  }
  const canonical = storage.load()
  const current = { ...canonical, archived: canonical.archived ?? view.archived }
  if (!commit()) {
    throw new Error('A transfer checkpoint changed; no sources were archived.')
  }
  const next = project(storage, current, keys, operationId)
  acknowledge(storage, operationId)
  return next
}

/** A committed batch survives a renderer crash or quota failure. An existing receipt also proves
 * projection happened before Undo, so recovery acknowledges it without archiving again. */
export function recoverTransferArchiveProjections(
  storage: SessionSidebarViewStorage,
  view: SessionSidebarView,
  api = projectionApi()
): SessionSidebarView {
  const scope = storage.projectionScope?.()
  if (!scope || !api?.pendingSessionTransferArchives) {
    return view
  }
  const pending = api.pendingSessionTransferArchives(scope)
  if (!pending) {
    throw new Error('Pending archive decisions could not be read.')
  }
  const canonical = storage.load() // Refuse to overwrite an unreadable canonical view.
  let next: SessionSidebarView = { ...canonical, archived: canonical.archived ?? view.archived }
  for (const { operationId, keys } of pending) {
    try {
      const receipt = next.transferArchiveReceipts?.[operationId]
      if (receipt && JSON.stringify(receipt) !== JSON.stringify(keys)) {
        throw new Error('Archive receipt identity mismatch.')
      }
      if (!receipt) {
        next = project(storage, next, keys, operationId)
      }
      acknowledge(storage, operationId, api)
    } catch {
      // Earlier projections may already be acknowledged. Publish that progress even if a later
      // operation fails, or the next ordinary sidebar save would erase the acknowledged work.
      // The failed operation stays pending in main and will be retried on the next load.
      break
    }
  }
  return next
}
