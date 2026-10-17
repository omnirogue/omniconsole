// The store readings session-parity-classification.ts classifies with, and the UNFILTERED canonical
// parity population (session parity, step 8; addendum C5): every row the Conversations sidebar
// builds — before its tag, agent and routine filters, deleted rows aside — each with its bucket,
// verification, tagged identity and archive as this computer resolves it. `omni session
// sidebar-counts` and `omni session list` both export exactly this, so the two read alike.

import type { AppState } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { mirroredConversationOwnerLedgers } from '@/store/slices/mirrored-conversation-ledger'
import {
  selectConversationLedgerEligibility,
  type ConversationLedgerEligibility
} from '@/runtime/session-conversation-ledger-eligibility'
import { publishedConversationLedgerRest } from '@/runtime/session-conversation-ledger-latest'
import {
  sessionParityPopulation,
  type SessionOwnerLedgerState,
  type SessionParityPopulation
} from '../../../shared/session-parity'
import { conversationViewKey, isSessionRowDeleted } from './conversation-view'
import { mirroredWorkflowOwnerArchivedKeys } from './mirrored-workflow-rows'
import { getShownChains } from './session-chain-registry'
import { pairedSessionOwnerTarget } from './session-manage-owner-target'
import { sessionOwnerArchiveKeys } from './session-owner-archive-keys'
import { getSessionOwnershipUnverifiedReason } from './session-ownership-verdict'
import {
  classifySessionParity,
  sessionParityRowOf,
  type SessionParityInputs
} from './session-parity-classification'
import { buildSidebarSessions } from './sidebar-sessions'

/**
 * The publisher's own eligibility selector (F7) over the sidebar's marks. Why guarded: the
 * management rows every `omni session` command and the steward read are built with it, so a failure
 * here must cost only the buckets — this computer's rows then count as its list unless labelled.
 */
export function readConversationLedgerEligibility(
  state: AppState
): ConversationLedgerEligibility | null {
  try {
    return selectConversationLedgerEligibility(state)
  } catch (error) {
    console.warn('[session-parity] reading the ledger eligibility failed', error)
    return null
  }
}

/** `eligibility` null reads this computer's rows without the ledger's rule. */
export function sessionParityInputs(
  state: AppState,
  eligibility: ConversationLedgerEligibility | null = readConversationLedgerEligibility(state)
): SessionParityInputs {
  return {
    eligibility,
    owners: state.mirroredConversationOwnersByEnvironment ?? {},
    ledgerBuckets: state.mirroredConversationLedgerByOwner ?? {},
    workflowBuckets: state.mirroredWorkflowRecordsByOwner ?? {},
    unverifiedReason: (session) => getSessionOwnershipUnverifiedReason(state, session),
    // Why guarded: a store not hydrated yet has no tab map, and then no owner pane is known.
    ownerPaneKey: (session) =>
      state.tabsByWorktree ? (pairedSessionOwnerTarget(state, session)?.paneKey ?? null) : null,
    publishedRest: publishedConversationLedgerRest
  }
}

/** G2: one line per paired owner this computer has heard from (or restored). */
export function sessionOwnerLedgerStates(
  state: Pick<AppState, 'mirroredConversationOwnersByEnvironment'>
): SessionOwnerLedgerState[] {
  return mirroredConversationOwnerLedgers(state.mirroredConversationOwnersByEnvironment ?? {}).map(
    (owner) => ({
      hostId: owner.hostId,
      generation: owner.generation,
      revision: owner.revision,
      source: owner.source,
      state: owner.state,
      asOf: owner.asOf
    })
  )
}

export function buildSessionParityPopulation(
  state: AppState,
  inputs: SessionParityInputs = sessionParityInputs(state)
): SessionParityPopulation {
  const viewStore = useSessionSidebarView.getState()
  if (!viewStore.loaded) {
    viewStore.load()
  }
  const { view, archived } = useSessionSidebarView.getState()
  const deleted = new Set(view.deleted ?? [])
  const sessions = buildSidebarSessions(state, getShownChains()).filter(
    (session) => !isSessionRowDeleted(deleted, session)
  )
  // Why the sidebar's own rule: archived as the list shows it, the owner's explicit mark first (C3).
  const archivedKeys = sessionOwnerArchiveKeys(
    [...archived, ...mirroredWorkflowOwnerArchivedKeys(state.mirroredWorkflowRecordsByOwner)],
    sessions
  )
  return sessionParityPopulation(
    sessions.map((session) =>
      sessionParityRowOf(
        session,
        classifySessionParity(session, inputs),
        archivedKeys.has(conversationViewKey(session))
      )
    ),
    sessionOwnerLedgerStates(state)
  )
}
