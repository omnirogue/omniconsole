// Pure reconciliation of one owner's conversation-ledger buckets on this receiver (session parity,
// step 5). A5/C1: membership is retained across generations, reconnects and restarts — a workspace
// is replaced whole only by a live `source: 'window'` message with complete coverage for it, and
// every other message (incomplete, main-authored) adds, updates and vouches. F15: a tombstone
// removes its row whatever the source or coverage, unless the same message lists that row. F21:
// records reconcile by tagged identity (`c:<digest>` | `p:<paneIdentity>`).

import {
  MIRRORED_CONVERSATION_DELETION_HISTORY_GAP,
  mirroredConversationBucketState,
  mirroredConversationTaggedIdentity,
  type MirroredConversationBucket,
  type MirroredConversationOwnerState
} from '@/store/slices/mirrored-conversation-ledger'
import type {
  RuntimeSessionConversationRecord,
  RuntimeSessionConversationRemoval,
  SessionConversationLedgerCoverage,
  SessionConversationLedgerSource
} from '../../../shared/session-conversation-ledger'
import {
  applyMirroredOwnerRecords,
  type MirroredOwnerIdentity
} from './mirrored-owner-set-decision'

/**
 * F21: a provider-less pane's row gives way to the same pane once it names its provider session;
 * two provider-less panes, or two conversations, never fold into one. A listed tab record also
 * supersedes the kept tab record of the same owner pane whatever its conversation (the pane
 * switched conversation while its workspace read incomplete): one owner pane, one row.
 */
export const MIRRORED_CONVERSATION_RECORD_IDENTITY: MirroredOwnerIdentity<RuntimeSessionConversationRecord> =
  {
    key: mirroredConversationTaggedIdentity,
    replaces: (record) =>
      record.conversation && record.paneIdentity ? [`p:${record.paneIdentity}`] : [],
    slot: (record) => (record.surface === 'tab' && record.paneIdentity) || null
  }

export type MirroredConversationMessage = {
  kind: 'set' | 'delta'
  generation: string
  revision: number
  source: SessionConversationLedgerSource
  /** A whole set's listing time; null for a delta (the bucket keeps its last one). */
  listedAt: number | null
  coverage: readonly SessionConversationLedgerCoverage[]
  /** A set's records, or a delta's changed workspaces (each one's whole list). */
  recordsByWorktree: Readonly<Record<string, readonly RuntimeSessionConversationRecord[]>>
  removals: readonly RuntimeSessionConversationRemoval[]
}

export type MirroredConversationReconciliation = {
  buckets: MirroredConversationBucket[]
  /** Identities a live window-complete workspace no longer lists: removed. */
  omitted: string[]
  /** Identities the message did not list but could not prove gone: kept. */
  retained: string[]
  /** Identities of kept tab records whose owner pane a listed record now runs: dropped. */
  superseded: string[]
  /** Rows a tombstone removed, as `[worktreeId, identity]`. */
  tombstoned: [string, string][]
  /** Workspaces that became unverified with this message (F15). */
  unverified: string[]
}

/** The `c:`/`p:` keys tombstones name, by workspace (a workflow tombstone names no ledger row). */
function tombstoneKeys(
  removals: readonly RuntimeSessionConversationRemoval[]
): Map<string, Set<string>> {
  const byWorktree = new Map<string, Set<string>>()
  for (const removal of removals) {
    const key = removal.conversation
      ? `c:${removal.conversation}`
      : removal.paneIdentity
        ? `p:${removal.paneIdentity}`
        : null
    if (key) {
      byWorktree.set(removal.worktreeId, (byWorktree.get(removal.worktreeId) ?? new Set()).add(key))
    }
  }
  return byWorktree
}

/** Why either identity: the owner deletes by digest or pane, and a row may carry both. */
function isTombstoned(
  record: RuntimeSessionConversationRecord,
  keys: ReadonlySet<string> | undefined
): boolean {
  return Boolean(
    keys &&
    ((record.conversation && keys.has(`c:${record.conversation}`)) ||
      (record.paneIdentity && keys.has(`p:${record.paneIdentity}`)))
  )
}

type BucketInputs = {
  environmentId: string
  worktreeId: string
  records: RuntimeSessionConversationRecord[]
  previous: MirroredConversationBucket | undefined
  message: MirroredConversationMessage
  coverage: ReadonlyMap<string, boolean>
  /** The message took this workspace whole (live window coverage, complete). */
  replaced: boolean
  receivedAt: number
  ownerState: MirroredConversationOwnerState
  deletionHistoryGap: boolean
}

/**
 * Whether the bucket's list was proven exact in this generation: a live window message with
 * complete coverage took it whole, so nothing retained from before can hide in it.
 */
function provenExact(bucket: MirroredConversationBucket, generation: string): boolean {
  return bucket.source === 'window' && bucket.coverage.complete && bucket.generation === generation
}

/** A workspace's bucket after the message, or null when nothing in it is worth keeping. */
function nextBucket(input: BucketInputs): MirroredConversationBucket | null {
  const { message, previous, worktreeId } = input
  const named = Object.hasOwn(message.recordsByWorktree, worktreeId)
  const covered = input.coverage.has(worktreeId)
  // Why a delta's coverage alone never raises a workspace it does not name: the owner sends
  // coverage for every workspace but names only the ones whose list changed, and an unnamed
  // bucket keeps whatever this receiver retained in it (a main set's or an incomplete set's
  // leftovers, a restored snapshot's rows), which the delta never saw. Only a set, or a delta
  // naming the workspace, proves its list exact; a bucket already proven in this generation is
  // kept or lowered (the window closed) by the delta's coverage, never raised.
  const confirms =
    named ||
    (covered &&
      (message.kind === 'set' ||
        (previous !== undefined && !previous.stale && provenExact(previous, message.generation))))
  const unverified = input.replaced
    ? undefined
    : input.deletionHistoryGap
      ? MIRRORED_CONVERSATION_DELETION_HISTORY_GAP
      : previous?.unverified
  if (!previous && !confirms) {
    return null
  }
  // Why kept empty only when replaced: an owner-vouched "none here" is evidence; else noise.
  if (input.records.length === 0 && !input.replaced) {
    return null
  }
  const stale = confirms ? false : previous?.stale === true
  const base = confirms
    ? {
        coverage: { complete: input.coverage.get(worktreeId) === true },
        source: message.source,
        generation: message.generation,
        revision: message.revision,
        listedAt: message.listedAt ?? previous?.listedAt ?? 0,
        asOf: input.receivedAt
      }
    : {
        // Why: a set that stops speaking for a workspace no longer vouches for its completeness.
        coverage: message.kind === 'set' ? { complete: false } : previous!.coverage,
        source: previous!.source,
        generation: previous!.generation,
        revision: previous!.revision,
        listedAt: previous!.listedAt,
        asOf: previous!.asOf
      }
  return {
    environmentId: input.environmentId,
    worktreeId,
    records: input.records,
    ...base,
    ownerState: mirroredConversationBucketState(input.ownerState, stale),
    ...(stale ? { stale: true as const } : {}),
    ...(unverified ? { unverified } : {})
  }
}

/** One owner's buckets after a whole set or a delta (see the module note for the rules). */
export function reconcileMirroredConversationBuckets(args: {
  environmentId: string
  current: readonly MirroredConversationBucket[]
  message: MirroredConversationMessage
  receivedAt: number
  ownerState: MirroredConversationOwnerState
  /** F15: deletions may be missing (history cut, or away longer than the owner keeps it). */
  deletionHistoryGap: boolean
}): MirroredConversationReconciliation {
  const { message } = args
  const coverage = new Map(message.coverage.map((entry) => [entry.worktreeId, entry.complete]))
  const wholeByCoverage = (worktreeId: string): boolean =>
    message.source === 'window' && coverage.get(worktreeId) === true
  const applied = applyMirroredOwnerRecords({
    current: args.current,
    listed: message.recordsByWorktree,
    replacesWhole: wholeByCoverage,
    scope: message.kind,
    identity: MIRRORED_CONVERSATION_RECORD_IDENTITY
  })
  // A set speaks for every covered workspace, also one it lists no record in.
  if (message.kind === 'set') {
    for (const { worktreeId } of message.coverage) {
      if (wholeByCoverage(worktreeId) && !applied.recordsByWorktree.has(worktreeId)) {
        applied.recordsByWorktree.set(worktreeId, [])
      }
    }
  }
  const fresh = new Set(
    Object.values(message.recordsByWorktree)
      .flat()
      .filter((record) => record.listed)
  )
  const tombstones = tombstoneKeys(message.removals)
  const previousByWorktree = new Map(args.current.map((bucket) => [bucket.worktreeId, bucket]))
  const result: MirroredConversationReconciliation = {
    buckets: [],
    omitted: applied.removed,
    retained: applied.retained,
    superseded: applied.superseded,
    tombstoned: [],
    unverified: []
  }
  for (const [worktreeId, records] of applied.recordsByWorktree) {
    const keys = tombstones.get(worktreeId)
    const kept = records.filter((record) => {
      // Why a fresh listing survives: the owner never tombstones a row the same message lists.
      const removed = !fresh.has(record) && isTombstoned(record, keys)
      if (removed) {
        result.tombstoned.push([worktreeId, mirroredConversationTaggedIdentity(record)])
      }
      return !removed
    })
    const previous = previousByWorktree.get(worktreeId)
    const bucket = nextBucket({
      environmentId: args.environmentId,
      worktreeId,
      records: kept,
      previous,
      message,
      coverage,
      receivedAt: args.receivedAt,
      ownerState: args.ownerState,
      deletionHistoryGap: args.deletionHistoryGap,
      replaced:
        wholeByCoverage(worktreeId) &&
        (message.kind === 'set' || Object.hasOwn(message.recordsByWorktree, worktreeId))
    })
    if (bucket) {
      result.buckets.push(bucket)
      if (bucket.unverified && !previous?.unverified) {
        result.unverified.push(worktreeId)
      }
    }
  }
  return result
}
