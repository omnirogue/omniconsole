// Session parity (step 8) in `omni session sidebar-counts`: each counted row's bucket, tagged
// identity and owner rest; per-host bucket counts beside the rendered totals (count = ownerListed +
// heldByOwner + receiverOnly + workflow, plus background terminals the switch counts with no row);
// every paired owner's ledger state (G2); and the unfiltered canonical population (C5). Built only
// when someone reads the counts, from one classification per read.

import type { AppState } from '@/store'
import { conversationViewKey } from '@/lib/conversation-view'
import { sessionCountBucketsByHost } from '@/lib/session-host-scope'
import {
  classifySessionParity,
  type SessionParityInputs
} from '@/lib/session-parity-classification'
import {
  buildSessionParityPopulation,
  sessionOwnerLedgerStates,
  sessionParityInputs
} from '@/lib/session-parity-population'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  addSessionParityCount,
  emptySessionParityBucketCounts,
  type SessionParityBucketCounts,
  type SessionParityCountInput,
  type SessionParityFields
} from '../../../../../shared/session-parity'
import {
  UNKNOWN_SESSION_SIDEBAR_HOST,
  type SessionSidebarCountsResult,
  type SessionSidebarHostCount
} from '../../../../../shared/session-sidebar-counts'

export type SidebarCountsParity = {
  inputs: SessionParityInputs
  fieldsOf: (session: SidebarSession) => SessionParityFields
}

/** One read's classifier: this window's own ledger eligibility is computed once for all rows. */
export function sidebarCountsParity(state: AppState): SidebarCountsParity {
  const inputs = sessionParityInputs(state)
  const classified = new WeakMap<SidebarSession, SessionParityFields>()
  return {
    inputs,
    fieldsOf: (session) => {
      let fields = classified.get(session)
      if (!fields) {
        fields = classifySessionParity(session, inputs)
        classified.set(session, fields)
      }
      return fields
    }
  }
}

/** The buckets of the counted rows per host, rows with no host under `unknown` (counts step 9). */
export function sidebarCountBuckets(
  parity: SidebarCountsParity,
  sessions: readonly SidebarSession[],
  archivedKeys: ReadonlySet<string>
): Map<string, SessionParityBucketCounts> {
  const classify = (session: SidebarSession): SessionParityCountInput => ({
    ...parity.fieldsOf(session),
    archived: archivedKeys.has(conversationViewKey(session))
  })
  const buckets = new Map<string, SessionParityBucketCounts>(
    sessionCountBucketsByHost(sessions, classify)
  )
  const hostless = sessions.filter((session) => !(session.displayHostId ?? session.hostId))
  if (hostless.length > 0) {
    const unknown = emptySessionParityBucketCounts()
    hostless.forEach((session) => addSessionParityCount(unknown, classify(session)))
    buckets.set(UNKNOWN_SESSION_SIDEBAR_HOST, unknown)
  }
  return buckets
}

/** A host's rendered count with its buckets; anything the count holds beyond its rows is background. */
export function withHostBuckets(
  entry: SessionSidebarHostCount,
  buckets: ReadonlyMap<string, SessionParityBucketCounts> | undefined
): SessionSidebarHostCount {
  if (!buckets) {
    return entry
  }
  const split = buckets.get(entry.hostId) ?? emptySessionParityBucketCounts()
  const rows = split.ownerListed + split.heldByOwner + split.receiverOnly + split.workflow
  return { ...entry, ...split, ...(entry.count > rows ? { background: entry.count - rows } : {}) }
}

/**
 * G2 and C5 for one read, whenever this window has restored its sessions: neither needs the
 * sidebar on screen, since both read the store, not what the list last rendered.
 */
export function readSidebarCountsParity(
  state: AppState,
  parity?: SidebarCountsParity
): Pick<SessionSidebarCountsResult, 'ownerLedgers' | 'parity'> {
  if (!state.workspaceSessionReady) {
    return {}
  }
  return {
    ownerLedgers: sessionOwnerLedgerStates(state),
    parity: buildSessionParityPopulation(state, parity?.inputs ?? sessionParityInputs(state))
  }
}
