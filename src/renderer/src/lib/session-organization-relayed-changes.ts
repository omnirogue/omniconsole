/**
 * An organize plan main prepared as several changes (one per kind): each is applied in order
 * through the same path as a single relayed change. One that fails changes nothing and does not
 * stop the others; main records each as applied or failed from this answer.
 */

import type {
  SessionOrganizeRelayOutcome,
  SessionOrganizeRelayReply
} from '../../../shared/session-organize'
import type { OrganizationChange } from '../../../shared/session-organization-change'
import type { OrganizationChangeDeps } from './session-organization-change'
import { applyRelayedOrganizationChange } from './session-organization-relayed-change'
import type { OrganizationStores } from './session-organization-values'

type FindSession = Parameters<typeof applyRelayedOrganizationChange>[2]

export function applyRelayedOrganizationChanges(
  changes: readonly OrganizationChange[],
  stores: OrganizationStores,
  findSession: FindSession,
  deps: Pick<OrganizationChangeDeps, 'checkRevision'> = {}
): SessionOrganizeRelayReply {
  const outcomes = changes.map((change): SessionOrganizeRelayOutcome => {
    try {
      return { ok: true, ...applyRelayedOrganizationChange(change, stores, findSession, deps) }
    } catch (error) {
      return {
        ok: false,
        opId: change.opId,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  return { outcomes }
}

/** Sessions touched by the applied changes, for the notice. */
export function organizedSessionCount(reply: SessionOrganizeRelayReply): number {
  const keys = new Set<string>()
  for (const outcome of reply.outcomes) {
    if (outcome.ok) {
      for (const target of outcome.targets) {
        keys.add(target.sessionKey ?? target.paneKey ?? target.tabId ?? '')
      }
    }
  }
  keys.delete('')
  return keys.size
}
