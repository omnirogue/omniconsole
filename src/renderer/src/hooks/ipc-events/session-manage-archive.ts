import { personalViewStorageKey } from '@/lib/personal-view-storage'
import { SESSION_SIDEBAR_VIEW_STORAGE_KEY } from '@/lib/session-sidebar-view-storage'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { buildSessionManageSidebarRows } from '@/lib/session-manage-sidebar-rows'
import { applyRecordedChange, transferArchiveChange } from '@/lib/session-organization-app-changes'
import { archiveSessionsByPerson } from '@/lib/session-organization-person-changes'
import { useAppStore } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { SessionManageRendererRequest } from '../../../../shared/session-manage-relay'

/** Archives a handoff's sources as one transfer change, recorded before it runs. */
export async function archiveTransferredSessions(
  request: Extract<SessionManageRendererRequest, { kind: 'archiveSessions' }>
): Promise<{ summary: string; operationId: string; archived: typeof request.targets }> {
  // A queued window request must expire before main stops waiting for its reply.
  if (!Number.isFinite(request.expiresAt) || Date.now() >= request.expiresAt) {
    throw new Error('The archive request expired; no sources were archived.')
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
  if (
    !request.targets.length ||
    request.targets.some((target) => identityFields.some((key) => !Object.hasOwn(target, key)))
  ) {
    throw new Error(
      'The archive request lacks complete source identities; no sources were archived.'
    )
  }
  const stores = { view: useSessionSidebarView }
  if (!stores.view.getState().loaded) {
    stores.view.getState().load()
  }
  const rows = buildSessionManageSidebarRows(useAppStore.getState())
  const acknowledged = request.acknowledgedTarget
  const currentTarget =
    acknowledged &&
    rows.find((row) =>
      identityFields.every(
        (key) =>
          Object.hasOwn(acknowledged, key) &&
          row[key as keyof typeof row] === acknowledged[key as keyof typeof acknowledged]
      )
    )
  if (
    !currentTarget ||
    currentTarget.archived ||
    currentTarget.hostUnavailable ||
    currentTarget.launchPending ||
    currentTarget.shellForeground
  ) {
    throw new Error('The acknowledged target changed or disappeared; no sources were archived.')
  }
  const sessions = request.targets.map((target) => {
    const row = rows.find((candidate) =>
      Object.entries(target).every(
        ([key, value]) => candidate[key as keyof typeof candidate] === value
      )
    )
    if (!row || row.archived || row.hostUnavailable || row.launchPending || row.shellForeground) {
      throw new Error('A source changed or became unavailable; no sources were archived.')
    }
    return { key: row.viewKey, label: row.title, tabId: row.tabId }
  })
  if (Date.now() >= request.expiresAt) {
    throw new Error('The archive request expired; no sources were archived.')
  }
  const archived = await applyRecordedChange(
    transferArchiveChange(
      sessions.map((session) => ({ sessionKey: session.key })),
      request.operationId,
      () =>
        Date.now() < request.expiresAt &&
        window.api.ui.commitSessionTransferArchive(
          request.commitToken,
          personalViewStorageKey(SESSION_SIDEBAR_VIEW_STORAGE_KEY)
        ),
      request.reason
    )
  )
  if (!archived.ok) {
    throw new Error(
      archived.error ?? 'The sources could not be archived; no sources were archived.'
    )
  }
  for (const session of sessions) {
    toast(`Archived “${session.label}”.`, {
      description: request.reason,
      duration: 12_000,
      action: {
        label: translate('conversations.cliFolders.undo', 'Undo'),
        onClick: () => archiveSessionsByPerson([session.key], false, { via: 'notice' })
      }
    })
  }
  return {
    summary: `Archived ${sessions.length} source conversations.`,
    operationId: request.operationId,
    archived: request.targets
  }
}
