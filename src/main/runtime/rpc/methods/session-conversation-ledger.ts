import { isDeepStrictEqual } from 'node:util'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  SESSION_CONVERSATION_LEDGER_EVENT,
  sessionConversationRemovalStampKey,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval
} from '../../../../shared/session-conversation-ledger'
import type { RpcContext } from '../core'
import type { SessionConversationLedgerStore } from '../../session-conversation-ledger-store'

/**
 * The owner conversation ledger on session.tabs (session parity, step 4): its listAll projection
 * and its subscribeAll stream, beside the workflow records' (session-workflow-records.ts) and
 * composed at the same call sites. A client that advertised `session-tabs.conversation-ledger.v1`
 * gets the owner's whole set as a `conversationLedger` field on listAll and on the subscribeAll
 * `snapshots` event, then one `conversationLedger` event per change. Any other client gets exactly
 * today's projection: no field, no event, and no store is created on its behalf (Rule 3).
 *
 * A5: a new `generation` (the owner runtime restarted) restarts revision ordering, so the stream
 * resends the whole set; by itself that removes nothing. Removing a row or a receiver's capture
 * still needs owner evidence the receiver judges: a `source: 'window'` set received live that
 * covers the workspace with `complete: true` and omits the conversation, or a tombstone in
 * `removals`. Nothing here infers a removal, and a `main` set is published exactly like a window
 * one; the receiver reads `source`.
 */

/** What the wire reads: the runtime's own ledger store, absent on runtime doubles without one. */
export type SessionConversationLedgerFeed = Pick<
  SessionConversationLedgerStore,
  'snapshot' | 'onChange' | 'removalsSince'
>

type LedgerContext = Pick<RpcContext, 'runtime' | 'clientCapabilities'>

/** The feed, only for a client that negotiated the ledger; for anyone else null, store untouched. */
function negotiatedFeed(context: LedgerContext): SessionConversationLedgerFeed | null {
  if (
    context.clientCapabilities?.includes(SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY) !==
    true
  ) {
    return null
  }
  // Why optional: runtime doubles (and older runtime shapes) carry no ledger store.
  const read = (
    context.runtime as { getSessionConversationLedgerStore?: () => SessionConversationLedgerFeed }
  )?.getSessionConversationLedgerStore
  return typeof read === 'function' ? read.call(context.runtime) : null
}

/** A full inventory with the owner's whole ledger beside it, for a negotiated client only. */
export function projectInventoryConversationLedger<T extends object>(
  inventory: T,
  context: LedgerContext
): T {
  const feed = negotiatedFeed(context)
  return feed ? { ...inventory, conversationLedger: feed.snapshot() } : inventory
}

function bucketOf(
  set: RuntimeSessionConversationLedger,
  worktreeId: string
): RuntimeSessionConversationRecord[] {
  return Object.hasOwn(set.recordsByWorktree, worktreeId)
    ? (set.recordsByWorktree[worktreeId] ?? [])
    : []
}

/** Each workspace whose list differs between two sets, with its new whole list (`[]` if none). */
function changedWorkspaces(
  before: RuntimeSessionConversationLedger,
  after: RuntimeSessionConversationLedger
): Record<string, RuntimeSessionConversationRecord[]> {
  const names = new Set([
    ...Object.keys(before.recordsByWorktree),
    ...Object.keys(after.recordsByWorktree)
  ])
  return Object.fromEntries(
    [...names]
      .filter(
        (worktreeId) =>
          !isDeepStrictEqual(bucketOf(before, worktreeId), bucketOf(after, worktreeId))
      )
      .map((worktreeId) => [worktreeId, bucketOf(after, worktreeId)])
  )
}

/**
 * Whether a delta can say everything that changed between two sets of one generation. A delta
 * carries buckets, coverage, source, folders, projects and new tombstones; it cannot carry the
 * omission counts, the cut workspaces or a change in the removal list's truncation, nor a
 * tombstone the owner withdrew (an undo): a delta only adds removals, so a receiver would keep
 * acting on the withdrawn one. Any of those resends the whole set. `listedAt` is not on a delta
 * (the contract has none) and moves on every publication, so it never forces a whole set.
 */
function deltaCarries(
  before: RuntimeSessionConversationLedger,
  after: RuntimeSessionConversationLedger
): boolean {
  if (
    before.generation !== after.generation ||
    !isDeepStrictEqual(before.omitted, after.omitted) ||
    !isDeepStrictEqual(before.truncatedWorktrees ?? [], after.truncatedWorktrees ?? []) ||
    (before.removalsTruncated === true) !== (after.removalsTruncated === true)
  ) {
    return false
  }
  const kept = new Set(after.removals.map(sessionConversationRemovalStampKey))
  return before.removals.every((removal) => kept.has(sessionConversationRemovalStampKey(removal)))
}

function ledgerDelta(
  before: RuntimeSessionConversationLedger,
  after: RuntimeSessionConversationLedger,
  removals: RuntimeSessionConversationRemoval[]
): RuntimeSessionConversationLedgerDelta {
  return {
    generation: after.generation,
    revision: after.revision,
    baseRevision: before.revision,
    source: after.source,
    // Why every workspace: a source or completeness change can move a workspace whose records
    // did not change (the window closing makes every workspace incomplete at once).
    coverage: after.coverage,
    changedByWorktree: changedWorkspaces(before, after),
    // A4: folders and projects ride only when they changed; absent means unchanged, never "none".
    ...(isDeepStrictEqual(before.folders, after.folders) ? {} : { folders: after.folders }),
    ...(isDeepStrictEqual(before.projects, after.projects) ? {} : { projects: after.projects }),
    // F15: every tombstone first published after the base revision; absent means none.
    ...(removals.length > 0 ? { removals } : {}),
    // Why repeated: the set said its removals were cut, so neither these nor their absence prove
    // anything (a change in truncation itself resends the whole set).
    ...(after.removalsTruncated ? { removalsTruncated: true as const } : {})
  }
}

/**
 * `session.tabs.subscribeAll`'s emit for a negotiated client: the `snapshots` inventory carries
 * the whole ledger, and every later change is one `conversationLedger` event ordered by revision.
 * Within one generation the event is a delta against the revision this stream last delivered —
 * only the workspaces whose lists changed, folders/projects only when changed, and the tombstones
 * `removalsSince` that revision — unless the delta cannot carry the change (`deltaCarries`); a new
 * generation or such a change resends the whole set. Watches only once the inventory went out and
 * stops at the stream's end or abort. Others get the emit unchanged; workflow events pass through.
 */
export function withSessionConversationLedgerStream(
  context: LedgerContext & Pick<RpcContext, 'signal'>,
  emit: (result: unknown) => void
): (result: unknown) => void {
  const feed = negotiatedFeed(context)
  if (!feed) {
    return emit
  }
  let stopWatching: (() => void) | null = null
  let delivered: RuntimeSessionConversationLedger | null = null
  let ended = false
  const stop = (): void => {
    ended = true
    stopWatching?.()
    stopWatching = null
  }
  const deliverChange = (): void => {
    const next = feed.snapshot()
    const before = delivered
    // Why: a call with nothing newer than what this stream delivered has nothing to say.
    if (before && before.generation === next.generation && next.revision <= before.revision) {
      return
    }
    delivered = next
    if (before && deltaCarries(before, next)) {
      emit({
        type: SESSION_CONVERSATION_LEDGER_EVENT,
        ...ledgerDelta(before, next, feed.removalsSince(before.revision))
      })
      return
    }
    emit({ type: SESSION_CONVERSATION_LEDGER_EVENT, ...next })
  }
  context.signal?.addEventListener('abort', stop, { once: true })
  return (result: unknown) => {
    const type = (result as { type?: unknown } | null)?.type
    if (type === 'end') {
      stop()
      emit(result)
      return
    }
    if (type !== 'snapshots') {
      emit(result)
      return
    }
    delivered = feed.snapshot()
    emit({ ...(result as object), conversationLedger: delivered })
    if (!stopWatching && !ended) {
      stopWatching = feed.onChange(deliverChange)
    }
  }
}
