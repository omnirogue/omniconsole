import {
  isPersonExecutor,
  organizationTargetKey,
  ownershipFieldOf,
  revisionFieldOf,
  type OrganizationChange,
  type OrganizationOwnershipField
} from '../../shared/session-organization-change'
import { ownedRevisionRefusal } from '../../shared/session-organization-ownership'
import type { OrganizationHistoryStore } from './organization-history-store'

const FIELD_NAMES: Record<OrganizationOwnershipField, string> = {
  placement: 'folder',
  title: 'title'
}

/**
 * Main's half of the revision check, before anything is recorded: a non-person change that names
 * the revision it expects is refused unless every target it can name here (by session or folder;
 * the window checks the rest once it has resolved them) is still at that revision. An owned field
 * is at its owner's revision only while it is still owned; any other field is at its newest change.
 */
export function staleRevisionRefusal(
  change: OrganizationChange,
  store: Pick<OrganizationHistoryStore, 'stateFor' | 'latestFor'>
): string | null {
  const expected = change.expectedRevision
  const field = revisionFieldOf(change.kind)
  if (!expected || !field || isPersonExecutor(change.executor)) {
    return null
  }
  const owned = ownershipFieldOf(change.kind)
  for (const target of change.targets) {
    if (!target.sessionKey && !target.folderId) {
      continue
    }
    const key = organizationTargetKey(target)!
    if (owned) {
      const refusal = ownedRevisionRefusal(store.stateFor(key), owned, expected)
      if (refusal?.reason === 'yours') {
        return `This session's ${FIELD_NAMES[owned]} is the person's now (${refusal.why}), so it is not changed without them. Nothing changed.`
      }
      if (refusal?.reason === 'not-owned') {
        return `No agent change still holds this session's ${FIELD_NAMES[owned]}, so it counts as the person's. Nothing changed.`
      }
      if (refusal) {
        return `This session's ${FIELD_NAMES[owned]} changed since revision ${expected} (it is at ${refusal.current}). Nothing changed.`
      }
      continue
    }
    const current = store.latestFor(key, field)?.revision
    if (current !== expected) {
      return `This ${target.sessionKey ? 'session' : 'folder'} changed since revision ${expected}${current ? ` (it is at ${current})` : ''}. Nothing changed.`
    }
  }
  return null
}

/** Throws the refusal, with nothing recorded; for the ledger's `prepare`. */
export function assertCurrentRevision(
  change: OrganizationChange,
  store: Pick<OrganizationHistoryStore, 'stateFor' | 'latestFor'>
): void {
  const refusal = staleRevisionRefusal(change, store)
  if (refusal) {
    throw new Error(refusal)
  }
}
