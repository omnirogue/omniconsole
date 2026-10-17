/**
 * The window's half of the steward's third archive rule: a blank session on an SSH host this
 * computer cannot reach. Its revision says the row is still that (a launcher's title, no provider
 * conversation, no prompt or work, off screen, held by nothing), a persisted clock says for how
 * long, and the last check before filing compares both with what main was granted on.
 */
import type { AppState } from '@/store'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isJunkSessionTitle } from '../../../shared/session-junk-title'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import {
  UNREACHABLE_BLANK_ARCHIVE_MS,
  unreachableBlankEvidence,
  type UnreachableBlankClock
} from '../../../shared/session-steward-unreachable-blank'
import { sessionOrganizationScope } from './account-sync/session-organization-intent'
import { conversationViewKey } from './conversation-view'
import { isSessionTabOnScreen } from './session-done-archive-policy'
import { isSessionSaved, type SessionFolderMetadata } from './session-folders'
import type { SessionSidebarView } from './session-sidebar-view'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'

/**
 * Statuses that say the host was tried and not reached. Not `disconnected`: a person may have
 * chosen it, which says nothing about the host. Anything else is still deciding.
 */
const UNREACHED = new Set(['auth-failed', 'reconnection-failed', 'error'])

/**
 * `null`: not a blank row on an unreachable host. `undefined`: it would be, but its host's state is
 * still being decided (a restart, a reconnect attempt), so an existing clock is kept, never started.
 */
export function sessionUnreachableBlankRevision(
  row: PursuitSidebarTreeRow,
  state: AppState,
  metadata: SessionFolderMetadata,
  view: SessionSidebarView,
  unique: boolean
): string | null | undefined {
  const { session } = row
  const host = parseExecutionHostId(session.hostId)
  const key = conversationViewKey(session)
  const status = session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : null
  const custom = session.customTitle?.trim()
  if (
    host?.kind !== 'ssh' ||
    !unique ||
    !session.unavailable ||
    session.kind !== 'terminal' ||
    !session.sessionKey ||
    session.providerSession?.id ||
    session.providerSession?.transcriptPath ||
    !isJunkSessionTitle(session.label) ||
    (custom && !isJunkSessionTitle(custom)) ||
    row.archived ||
    row.attention ||
    row.planNeedsYou ||
    row.unreadCompletion ||
    row.waitingUntil ||
    row.backgroundTaskCount ||
    status?.prompt ||
    status?.state === 'working' ||
    status?.state === 'blocked' ||
    (session.tabId && isSessionTabOnScreen(state, session.tabId)) ||
    view.deleted?.includes(key) ||
    view.autoArchiveKeep?.includes(key) ||
    isSessionSaved(metadata, key)
  ) {
    return null
  }
  if (!UNREACHED.has(state.sshConnectionStates?.get(host.targetId)?.status ?? '')) {
    return undefined
  }
  // Why the stored title: a generated one may arrive later without the row changing.
  return JSON.stringify([
    sessionOrganizationScope(),
    session.rowKey,
    session.sessionKey,
    session.worktreeId,
    session.hostId,
    custom ?? null,
    status?.updatedAt ?? null
  ])
}

/** The clock a row's current revision may use; a changed revision starts over. */
export function unreachableBlankPolicy(
  view: SessionSidebarView,
  key: string,
  revision: string | null | undefined
): UnreachableBlankClock | null {
  const clock = view.unreachableBlankClocks?.[key]
  return revision && clock?.revision === revision ? clock : null
}

/** The window's last synchronous check of a third-rule archive, for one of its targets. */
export function unreachableBlankRefusal(
  row: Pick<
    SessionManageSidebarRow,
    'viewKey' | 'unreachableBlankRevision' | 'unreachableBlankPolicy'
  >,
  evidence: string | undefined,
  now = Date.now()
): string | null {
  const revision = row.unreachableBlankRevision
  const clock = row.unreachableBlankPolicy
  return revision &&
    clock?.revision === revision &&
    now - clock.since >= UNREACHABLE_BLANK_ARCHIVE_MS &&
    evidence?.includes(unreachableBlankEvidence(row.viewKey, revision))
    ? null
    : 'The session is no longer blank on an unreachable host, or its host answered; it stays visible.'
}
