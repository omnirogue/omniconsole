import type { SessionArchiveProjection } from '../../../shared/session-archive-projection'
import type { SessionManageConversationOrganization } from '../../../shared/session-manage-relay'
import { sessionManageHostKey } from '../../../shared/session-manage-query'
import type { SessionSidebarView } from './session-sidebar-view'

type ArchiveView = Pick<SessionSidebarView, 'autoArchiveLog'>

/** Automatic when its newest filing receipt is still unrestored; any other archive is manual. */
export function sessionArchiveKind(
  view: ArchiveView,
  archived: readonly string[],
  key: string,
  ownerArchive?: SessionArchiveProjection
): 'manual' | 'automatic' | null {
  if (ownerArchive) {
    return ownerArchive.archived ? (ownerArchive.byHand ? 'manual' : 'automatic') : null
  }
  if (!archived.includes(key)) {
    return null
  }
  const receipt = view.autoArchiveLog?.findLast((entry) => entry.key === key)
  return receipt && !receipt.restoredAt ? 'automatic' : 'manual'
}

/** The host and provider id a `providerSessionFolderKey` names, or null for pane/chat keys. */
function providerKeyParts(key: string): { hostId: string; sessionId: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed[1] !== 'provider' || typeof parsed[2] !== 'string') {
    return null
  }
  // `${worktreeId}\0${agent}\0${key}\0${id}` (see getProviderSessionClaimKey).
  const sessionId = parsed[2].split('\0')[3]
  const hostId = sessionManageHostKey(typeof parsed[0] === 'string' ? parsed[0] : null)
  return hostId && sessionId ? { hostId, sessionId } : null
}

function holds(key: string, hostId: string, sessionId: string): boolean {
  const parts = providerKeyParts(key)
  return parts !== null && parts.hostId === hostId && parts.sessionId.toLowerCase() === sessionId
}

/**
 * How this device has one provider conversation filed, from view keys alone, so a conversation
 * whose tab is closed still answers. Why keys: a closed conversation has no row to read.
 */
export function conversationOrganizationFor(
  view: SessionSidebarView,
  archived: readonly string[],
  target: { hostId: string; sessionId: string }
): SessionManageConversationOrganization {
  const hostId = sessionManageHostKey(target.hostId)
  const sessionId = target.sessionId.toLowerCase()
  if (!hostId) {
    return { deleted: false, hidden: false, archiveKind: null }
  }
  const matches = (key: string): boolean => holds(key, hostId, sessionId)
  const hiddenKeys = view.hidden
    .filter((entry) => entry.startsWith('conversation:') || entry.startsWith('session:'))
    .map((entry) => entry.slice(entry.indexOf(':') + 1))
  const archivedKey = archived.find(matches)
  const deletedKeys = (view.deleted ?? []).filter(matches)
  const hiddenMatches = hiddenKeys.filter(matches)
  return {
    deleted: deletedKeys.length > 0,
    hidden: hiddenMatches.length > 0,
    archiveKind: archivedKey ? sessionArchiveKind(view, archived, archivedKey) : null,
    ...(deletedKeys.length > 0 ? { deletedKeys } : {}),
    ...(hiddenMatches.length > 0 ? { hiddenKeys: hiddenMatches } : {})
  }
}
