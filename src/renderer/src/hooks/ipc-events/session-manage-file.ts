import { buildSessionManageSidebarRows } from '@/lib/session-manage-sidebar-rows'
import { applyRecordedChange, transferFilingChange } from '@/lib/session-organization-app-changes'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import type { SessionManageRendererRequest } from '../../../../shared/session-manage-relay'

export function readTransferFileReceipt(operationId: string): unknown {
  return useSessionFolders.getState().readTransferReceipt(operationId)
}

/**
 * The exact target placement and its receipt are one durable folder-store write, recorded as a
 * transfer before it runs.
 */
export async function fileTransferredSession(
  request: Extract<SessionManageRendererRequest, { kind: 'fileTransferredSession' }>
): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/.test(request.operationId)) {
    throw new Error('Invalid filing operation identity.')
  }
  const prior = useSessionFolders.getState().readTransferReceipt(request.operationId)
  if (prior) {
    if (prior.sessionKey !== request.target.viewKey || prior.folderId !== request.folderId) {
      throw new Error('Filing operation identity conflict.')
    }
    return prior
  }
  if (!Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) {
    throw new Error('The filing request expired without a receipt.')
  }
  const identityFields = [
    'paneKey',
    'viewKey',
    'worktreeId',
    'tabId',
    'kind',
    'structuredSessionId',
    'hostId'
  ]
  if (identityFields.some((key) => !Object.hasOwn(request.target, key))) {
    throw new Error('The filing request lacks complete target identity.')
  }
  const row = buildSessionManageSidebarRows(useAppStore.getState()).find((candidate) =>
    Object.entries(request.target).every(
      ([key, value]) => candidate[key as keyof typeof candidate] === value
    )
  )
  if (!row || row.archived || row.hostUnavailable) {
    throw new Error('The created target changed or is unavailable; it was not filed.')
  }
  if (!useSessionFolders.getState().loaded) {
    useSessionFolders.getState().load()
  }
  if (Date.now() >= request.expiresAt) {
    throw new Error('The target placement could not be saved durably.')
  }
  const filed = await applyRecordedChange(
    transferFilingChange(row.viewKey, request.folderId, request.operationId, request.expiresAt)
  )
  if (!filed.ok) {
    throw new Error(filed.error ?? 'The target placement could not be saved durably.')
  }
  return useSessionFolders.getState().readTransferReceipt(request.operationId)
}
