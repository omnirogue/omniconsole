import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  RuntimeSessionConversationRecord,
  RuntimeSessionConversationRemoval,
  SessionConversationLedgerFolder,
  SessionConversationLedgerOmitted,
  SessionConversationLedgerProject,
  SessionConversationLedgerSource
} from '../../../../shared/session-conversation-ledger'

/**
 * G2: what this receiver can say about one owner's conversation ledger.
 * - `ready`: a set from this owner arrived live on the current connection.
 * - `stale`: restored from the durable snapshot; nothing live yet ("as of <time>").
 * - `older`: the owner answered a fresh connection with no ledger (an older OmniConsole, or one
 *   that lost the capability): its paused and archived conversations are not listed.
 * - `unreachable`: the connection the last set came on dropped; rows stay as last listed.
 */
export const MIRRORED_CONVERSATION_OWNER_STATES = [
  'ready',
  'stale',
  'older',
  'unreachable'
] as const
export type MirroredConversationOwnerState = (typeof MIRRORED_CONVERSATION_OWNER_STATES)[number]

/** F15: rows kept although deletions on the owner may be missing (history cut or outlived). */
export const MIRRORED_CONVERSATION_DELETION_HISTORY_GAP =
  'disconnected-longer-than-deletion-history'
export type MirroredConversationUnverifiedReason = typeof MIRRORED_CONVERSATION_DELETION_HISTORY_GAP

/**
 * One paired owner's conversations in one workspace, as this receiver last reconciled them from
 * the owner's ledger (session parity, step 5). Never merged across owners (F8).
 */
export type MirroredConversationBucket = {
  environmentId: string
  worktreeId: string
  records: RuntimeSessionConversationRecord[]
  /** The owner's completeness for this workspace as of the message that last spoke for it. */
  coverage: { complete: boolean }
  source: SessionConversationLedgerSource
  generation: string
  revision: number
  /** The owner's listing time of the last whole set (deltas carry none). */
  listedAt: number
  /** This bucket's display state: the owner's, or `stale` while it shows restored rows only. */
  ownerState: MirroredConversationOwnerState
  /** Receipt time here of the newest set or delta that confirmed this bucket ("as of"). */
  asOf: number
  /** Restored from the durable snapshot and not confirmed live since: listed, never retires. */
  stale?: true
  unverified?: MirroredConversationUnverifiedReason
}

/** One paired owner's ledger as a whole: its state, ordering, catalog and deletion tombstones. */
export type MirroredConversationOwner = {
  environmentId: string
  state: MirroredConversationOwnerState
  /** Receipt time of the newest applied set or delta (or of the restored snapshot); null: none. */
  asOf: number | null
  generation: string | null
  revision: number | null
  source: SessionConversationLedgerSource | null
  listedAt: number | null
  folders: SessionConversationLedgerFolder[]
  projects: SessionConversationLedgerProject[]
  omitted: SessionConversationLedgerOmitted
  /** The owner's retained tombstones; a capture matching one is a conversation it deleted. */
  removals: RuntimeSessionConversationRemoval[]
  removalsTruncated?: true
  /** G4: the owner's durable session-host journal id, when this receiver knows it. */
  ownerHostId?: string
}

export type MirroredConversationLedgerSlice = {
  /**
   * Owner-qualified (environment, workspace) buckets, keyed by mirroredConversationBucketKey.
   * Receiver-only AppState, never a WorkspaceSessionState field: owners republish on reconnect and
   * main keeps a durable snapshot beside it (session-host/ledgers).
   */
  mirroredConversationLedgerByOwner: Record<string, MirroredConversationBucket>
  /** One entry per owner environment that sent, refused or restored a ledger. */
  mirroredConversationOwnersByEnvironment: Record<string, MirroredConversationOwner>
}

export function mirroredConversationBucketKey(environmentId: string, worktreeId: string): string {
  return JSON.stringify([environmentId, worktreeId])
}

/**
 * F21: a ledger record's identity on this receiver — `c:<digest>` when a provider session is
 * known, else `p:<paneIdentity>` — the same tags `sessionConversationRemovalKey` uses. Rows built
 * from the ledger key on `['runtime:<env>', 'ledger', worktreeId, <this>]`.
 */
export function mirroredConversationTaggedIdentity(
  record: Pick<RuntimeSessionConversationRecord, 'conversation' | 'paneIdentity'>
): string {
  return record.conversation ? `c:${record.conversation}` : `p:${record.paneIdentity ?? ''}`
}

/** A bucket's display state: what the owner is, unless it only shows restored rows. */
export function mirroredConversationBucketState(
  ownerState: MirroredConversationOwnerState,
  stale: boolean
): MirroredConversationOwnerState {
  return stale && ownerState === 'ready' ? 'stale' : ownerState
}

/**
 * Whether a bucket's membership was proven by the owner's window: a live `source: 'window'` set
 * or delta with complete coverage for the workspace, from an owner reachable now, nothing restored
 * or unverified. Only such a bucket may stand for an absence (step 7's retirement precondition).
 */
export function isMirroredConversationBucketAuthoritative(
  bucket: MirroredConversationBucket
): boolean {
  return (
    bucket.source === 'window' &&
    bucket.coverage.complete &&
    bucket.ownerState === 'ready' &&
    !bucket.stale &&
    !bucket.unverified
  )
}

/**
 * Whether a bucket speaks for its rows now: its owner is ready, nothing in it is restored or
 * unverified. Only such a bucket's archive mark, folder, title and rest override what this
 * computer's frames and local marks say for a row it joined; a frozen bucket (older owner, a
 * restored snapshot, a history gap) vouches for presence and counts only, so the owner's live
 * frame (#1081) and the local placement stand, as they did before the ledger.
 */
export function isMirroredConversationBucketLive(bucket: MirroredConversationBucket): boolean {
  return bucket.ownerState === 'ready' && !bucket.stale && !bucket.unverified
}

/**
 * Whether this owner publishes the ledger (F9: its tab frames then retire no captures by
 * themselves): it sent or restored one and has not since answered without one.
 */
export function ownerPublishesMirroredConversationLedger(
  owner: MirroredConversationOwner | undefined
): boolean {
  return Boolean(owner && owner.generation !== null && owner.state !== 'older')
}

export function selectMirroredConversationBuckets(
  state: Pick<AppState, 'mirroredConversationLedgerByOwner'>
): Record<string, MirroredConversationBucket> {
  return state.mirroredConversationLedgerByOwner
}

export function selectMirroredConversationOwners(
  state: Pick<AppState, 'mirroredConversationOwnersByEnvironment'>
): Record<string, MirroredConversationOwner> {
  return state.mirroredConversationOwnersByEnvironment
}

/** One owner's buckets (any order). */
export function mirroredConversationBucketsForEnvironment(
  buckets: Record<string, MirroredConversationBucket>,
  environmentId: string
): MirroredConversationBucket[] {
  return Object.values(buckets).filter((bucket) => bucket.environmentId === environmentId)
}

export type MirroredConversationOwnerLedger = {
  /** The execution host rows carry for this owner: `runtime:<environmentId>`. */
  hostId: string
  environmentId: string
  ownerHostId?: string
  generation: string | null
  revision: number | null
  source: SessionConversationLedgerSource | null
  state: MirroredConversationOwnerState
  asOf: number | null
}

/** G2: one line per owner, for counts (`ownerLedgers`), `omni session hosts` and group headers. */
export function mirroredConversationOwnerLedgers(
  owners: Record<string, MirroredConversationOwner>
): MirroredConversationOwnerLedger[] {
  return Object.values(owners).map((owner) => ({
    hostId: `runtime:${owner.environmentId}`,
    environmentId: owner.environmentId,
    ...(owner.ownerHostId ? { ownerHostId: owner.ownerHostId } : {}),
    generation: owner.generation,
    revision: owner.revision,
    source: owner.source,
    state: owner.state,
    asOf: owner.asOf
  }))
}

export const createMirroredConversationLedgerSlice: StateCreator<
  AppState,
  [],
  [],
  MirroredConversationLedgerSlice
> = () => ({ mirroredConversationLedgerByOwner: {}, mirroredConversationOwnersByEnvironment: {} })
