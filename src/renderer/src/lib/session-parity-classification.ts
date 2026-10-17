// Which list each sidebar row is on, and how sure this computer is of it (session parity, step 8;
// addendum C5, F7, F21, graft G1). One rule on every computer:
// - a row a paired owner's ledger vouches for carries the owner's word (`mirroredConversation`):
//   listed → ownerListed, held without listing → heldByOwner;
// - this computer's own rows follow its own ledger's eligibility rule (the publisher's selector,
//   F7): published rows are its list; quarantined ones are listed only here and can't be verified;
// - a paired computer's row no ledger names is listed only here — can't verify when that owner
//   publishes a ledger (its list is the authority) or the row itself is labelled so;
// - workflows ride their own records and are reported apart.
// Pure: the caller hands in the store readings (session-parity-population.ts reads the app store).

import type { ConversationLedgerEligibility } from '@/runtime/session-conversation-ledger-eligibility'
import {
  mirroredConversationBucketKey,
  ownerPublishesMirroredConversationLedger,
  type MirroredConversationBucket,
  type MirroredConversationOwner
} from '@/store/slices/mirrored-conversation-ledger'
import {
  mirroredWorkflowBucketKey,
  type MirroredWorkflowBucket
} from '@/store/slices/mirrored-workflow-records'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  sessionConversationIdentityFromProviderKey,
  sessionConversationPaneIdentity,
  type SessionConversationRest
} from '../../../shared/session-conversation-ledger'
import {
  sessionParityRecordIdentity,
  sessionParityRow,
  type SessionParityFields,
  type SessionParityRow
} from '../../../shared/session-parity'
import { UNKNOWN_SESSION_SIDEBAR_HOST } from '../../../shared/session-sidebar-counts'
import type { SidebarSession } from './sidebar-session-types'

export type SessionParityInputs = {
  /** F7: this window's own ledger eligibility; null when unread (its own rows then count as listed). */
  eligibility: ConversationLedgerEligibility | null
  owners: Readonly<Record<string, MirroredConversationOwner>>
  ledgerBuckets: Readonly<Record<string, MirroredConversationBucket>>
  workflowBuckets: Readonly<Record<string, MirroredWorkflowBucket>>
  /** The "can't verify" reason the row's own label shows (getSessionOwnershipUnverifiedReason). */
  unverifiedReason: (session: SidebarSession) => string | null
  /** The owner's own pane for a paired mirror row (pairedSessionOwnerTarget), when known. */
  ownerPaneKey: (session: SidebarSession) => string | null
  /** The rest this window's own ledger last published for one of its conversations. */
  publishedRest: (worktreeId: string, identity: string) => SessionConversationRest | undefined
}

type Identity = Pick<SessionParityFields, 'identity' | 'conversation' | 'paneIdentity'>

function tagged(conversation: string | null, paneIdentity: string | undefined): Identity {
  return {
    identity: sessionParityRecordIdentity({ conversation, paneIdentity }),
    conversation,
    ...(paneIdentity ? { paneIdentity } : {})
  }
}

/**
 * A row's own claim (F1): the digest of its full provider key — the same digest the owner sends,
 * since a mirrored workspace keeps the owner's worktree id — else the pane it names.
 */
function claimIdentity(session: SidebarSession, paneKey: string | null): Identity {
  const conversation = session.sessionKey
    ? (sessionConversationIdentityFromProviderKey(session.sessionKey)?.conversation ?? null)
    : null
  return tagged(conversation, paneKey ? sessionConversationPaneIdentity(paneKey) : undefined)
}

function workflowFields(session: SidebarSession, inputs: SessionParityInputs): SessionParityFields {
  const mirrored = session.mirroredWorkflow
  const anchor = mirrored?.hostTabId ?? session.tabId
  const bucket = mirrored
    ? inputs.workflowBuckets[mirroredWorkflowBucketKey(mirrored.environmentId, session.worktreeId)]
    : undefined
  return {
    bucket: 'workflow',
    verification: bucket?.unverified ? 'unverified' : bucket?.stale ? 'stale' : 'verified',
    identity: anchor ? `w:${anchor}` : null,
    conversation: null,
    ...(bucket?.stale ? { stale: true as const } : {}),
    ...(bucket?.unverified ? { bucketReason: 'controller-unverified' } : {})
  }
}

/** The owner's word on a row its ledger lists or holds (step 6's `mirroredConversation`). */
function vouchedFields(
  conversation: NonNullable<SidebarSession['mirroredConversation']>
): SessionParityFields {
  const { ownerState } = conversation
  // Why: an older owner no longer publishes, so what it once listed can't be verified; an owner out
  // of reach (or a restored snapshot) is as last listed.
  const reason = conversation.unverified ?? (ownerState === 'older' ? 'owner-older' : undefined)
  return {
    bucket: conversation.listed ? 'ownerListed' : 'heldByOwner',
    verification: reason
      ? 'unverified'
      : conversation.stale || ownerState !== 'ready'
        ? 'stale'
        : 'verified',
    ...tagged(conversation.conversation, conversation.paneIdentity),
    rest: conversation.rest,
    ...(conversation.stale ? { stale: true as const } : {}),
    ...(reason ? { bucketReason: reason } : {})
  }
}

/** A paired computer's row that no ledger record vouches for: listed only here. */
function pairedFields(
  session: SidebarSession,
  environmentId: string,
  inputs: SessionParityInputs
): SessionParityFields {
  const reason = inputs.unverifiedReason(session)
  const pane =
    session.kind === 'terminal' ? (inputs.ownerPaneKey(session) ?? session.paneKey) : null
  const identity = claimIdentity(session, pane)
  if (session.kind === 'structured' && !reason) {
    // Why: no ledger carries chats, so the owner's tab frame naming one is the owner's own list.
    return { bucket: 'ownerListed', verification: 'verified', ...identity }
  }
  const ledger = ownerPublishesMirroredConversationLedger(inputs.owners[environmentId])
  const bucket =
    inputs.ledgerBuckets[mirroredConversationBucketKey(environmentId, session.worktreeId)]
  const unlisted = ledger
    ? bucket && !bucket.coverage.complete
      ? 'owner-ledger-incomplete'
      : 'not-in-owner-ledger'
    : undefined
  return {
    bucket: 'receiverOnly',
    // Why verified without a ledger: an older owner's tab frames still vouch for its live tabs, as
    // they always have; only its captures carry the "can't verify" label.
    verification: reason || ledger ? 'unverified' : 'verified',
    ...identity,
    ...(reason || unlisted ? { bucketReason: reason ?? unlisted } : {})
  }
}

export function classifySessionParity(
  session: SidebarSession,
  inputs: SessionParityInputs
): SessionParityFields {
  if (session.workflow || session.mirroredWorkflow) {
    return workflowFields(session, inputs)
  }
  if (session.mirroredConversation) {
    return vouchedFields(session.mirroredConversation)
  }
  if (inputs.eligibility?.published.has(session.rowKey)) {
    const identity = claimIdentity(session, session.paneKey)
    const rest = identity.identity
      ? inputs.publishedRest(session.worktreeId, identity.identity)
      : undefined
    return {
      bucket: 'ownerListed',
      verification: 'verified',
      ...identity,
      ...(rest ? { rest } : {})
    }
  }
  const quarantine = inputs.eligibility?.quarantined.get(session.rowKey)
  if (quarantine) {
    // Why a launch in flight counts as this computer's own: a `local` row with no conversation
    // and no pane yet is one this window is starting; the ledger leaves it out only until it has
    // an identity (its workspace stays incomplete meanwhile), so the heading counts it and no
    // "+1 only here" appears on a computer with no paired owner at all.
    if (quarantine === 'no-identity' && session.hostId === 'local') {
      return {
        bucket: 'ownerListed',
        verification: 'verified',
        ...claimIdentity(session, session.paneKey)
      }
    }
    return {
      bucket: 'receiverOnly',
      verification: 'unverified',
      ...claimIdentity(session, session.paneKey),
      bucketReason: quarantine
    }
  }
  const host = parseExecutionHostId(session.hostId)
  if (host?.kind === 'runtime') {
    return pairedFields(session, host.environmentId, inputs)
  }
  // Why: this computer's own rows no ledger carries (its SSH sessions and chats) are its own list;
  // a row with no host at all may be a paired computer's, so it is never counted as this one's.
  const reason = host ? inputs.unverifiedReason(session) : 'unknown-host'
  return {
    bucket: reason ? 'receiverOnly' : 'ownerListed',
    verification: reason ? 'unverified' : 'verified',
    ...claimIdentity(session, session.kind === 'terminal' ? session.paneKey : null),
    ...(reason ? { bucketReason: reason } : {})
  }
}

/** One row of the canonical population, under the host the sidebar counts it under. */
export function sessionParityRowOf(
  session: SidebarSession,
  fields: SessionParityFields,
  archived: boolean
): SessionParityRow {
  return sessionParityRow({
    hostId: session.displayHostId ?? session.hostId ?? UNKNOWN_SESSION_SIDEBAR_HOST,
    worktreeId: session.worktreeId,
    kind: session.kind,
    agent: session.agent,
    archived,
    label: session.label,
    ...fields
  })
}
