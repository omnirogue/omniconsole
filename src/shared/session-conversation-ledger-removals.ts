/**
 * Deletion tombstones in the owner conversation ledger (addendum F4, F15). Deleting a conversation
 * is first-class owner evidence: the owner keeps a durable deleted state per conversation, and
 * every set it publishes — window- or main-authored — carries the retained `removals`; a delta
 * carries every removal first published after its `baseRevision`. The window's publication to its
 * own main carries none: main authors every tombstone from durable owner state.
 *
 * A5/F15: a tombstone removes a row and its capture regardless of coverage or source — it is the
 * owner saying "deleted", not an inference from absence — while an ordinary omission from a
 * main-authored or incomplete set still removes nothing. Because a tombstone is acted on without
 * any coverage check, it must name exactly one conversation: one identity (the full-claim digest,
 * the pane identity of a provider-less conversation, or a workflow's anchor tab) in one workspace.
 * An entry naming none or several, with no workspace or no finite deletion time, is dropped, never
 * guessed at. The list keeps the newest SESSION_CONVERSATION_LEDGER_LIMITS.removals by `at`;
 * whatever was cut sets `removalsTruncated`, and a receiver that sees it (or reconnects after the
 * retention window) removes nothing by inference and marks the owner's rows unverified until the
 * next window-complete coverage. No set tombstones a conversation it also lists: the owner holds
 * such a tombstone back while the row is listed (`sessionConversationListedRemovalKeys`) and sends
 * it again, as new, once the row goes.
 */

import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  isSessionConversationIdentity,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval
} from './session-conversation-ledger-contract'
import { asObject, boundedText } from './session-conversation-ledger-read-primitives'

const {
  removals: MAX_REMOVALS,
  id: MAX_ID,
  paneKey: MAX_PANE_KEY,
  worktreeId: MAX_WORKTREE_ID
} = SESSION_CONVERSATION_LEDGER_LIMITS
const PANE_PREFIX = 'pane:'
const IDENTITY_FIELDS = ['conversation', 'paneIdentity', 'workflowTabId'] as const

type RemovalIdentity = Pick<
  RuntimeSessionConversationRemoval,
  'conversation' | 'paneIdentity' | 'workflowTabId'
>

/**
 * What a receiver matches a tombstone by: its identity kind and value within its workspace, the
 * deletion time aside — `["c:<digest>", worktreeId]`, `["p:pane:<paneKey>", worktreeId]` or
 * `["w:<workflowTabId>", worktreeId]` as JSON (unambiguous whatever the ids hold). A receiver keys
 * its own row the same way from the row's identity. Given several identities the first of
 * conversation, pane, workflow tab names it (a read removal has exactly one); given none, ''.
 */
export function sessionConversationRemovalKey(
  removal: RemovalIdentity & Pick<RuntimeSessionConversationRemoval, 'worktreeId'>
): string {
  const identity = removal.conversation
    ? `c:${removal.conversation}`
    : removal.paneIdentity
      ? `p:${removal.paneIdentity}`
      : removal.workflowTabId
        ? `w:${removal.workflowTabId}`
        : null
  return identity ? JSON.stringify([identity, removal.worktreeId]) : ''
}

/**
 * The removal keys a set's listed records shield: each `listed` record's digest and its pane
 * identity, in its workspace. Why both: a receiver retires a capture by either one (1b, F15), so a
 * tombstone naming either identity of a conversation the same set lists would remove a row the
 * owner still shows — a deleted conversation whose tab is open again. Listed evidence wins: the
 * owner holds such a tombstone back while the row is listed. Passive `listed: false` evidence
 * shields nothing; the person's delete outranks it.
 */
export function sessionConversationListedRemovalKeys(
  recordsByWorktree: Readonly<
    Record<
      string,
      readonly Pick<RuntimeSessionConversationRecord, 'conversation' | 'paneIdentity' | 'listed'>[]
    >
  >
): Set<string> {
  const keys = new Set<string>()
  for (const [worktreeId, records] of Object.entries(recordsByWorktree)) {
    for (const { conversation, paneIdentity, listed } of records) {
      if (listed && conversation) {
        keys.add(sessionConversationRemovalKey({ conversation, worktreeId }))
      }
      if (listed && paneIdentity) {
        keys.add(sessionConversationRemovalKey({ paneIdentity, worktreeId }))
      }
    }
  }
  return keys
}

/** One tombstone exactly: its identity, workspace and deletion time (the owner store's stamp key). */
export function sessionConversationRemovalStampKey(
  removal: RuntimeSessionConversationRemoval
): string {
  return JSON.stringify([sessionConversationRemovalKey(removal), removal.at])
}

/** The single identity an entry sends, or null when it sends none, several, or an unreadable one. */
function readRemovalIdentity(raw: Record<string, unknown>): RemovalIdentity | null {
  // Why null counts as absent: records send `conversation: null` for "none", so may removals.
  const sent = IDENTITY_FIELDS.filter((field) => raw[field] !== undefined && raw[field] !== null)
  if (sent.length !== 1) {
    return null
  }
  if (sent[0] === 'conversation') {
    return isSessionConversationIdentity(raw.conversation)
      ? { conversation: raw.conversation }
      : null
  }
  if (sent[0] === 'paneIdentity') {
    const pane = boundedText(raw.paneIdentity, MAX_PANE_KEY + PANE_PREFIX.length)
    return pane?.startsWith(PANE_PREFIX) && pane.length > PANE_PREFIX.length
      ? { paneIdentity: pane }
      : null
  }
  const workflowTabId = boundedText(raw.workflowTabId, MAX_ID)
  return workflowTabId ? { workflowTabId } : null
}

/** One tombstone with its known fields only, or null when it is not exact (see the module note). */
export function readSessionConversationRemoval(
  value: unknown
): RuntimeSessionConversationRemoval | null {
  const raw = asObject(value)
  const identity = raw ? readRemovalIdentity(raw) : null
  const worktreeId = raw ? boundedText(raw.worktreeId, MAX_WORKTREE_ID) : null
  const at = raw?.at
  return identity && worktreeId && typeof at === 'number' && Number.isFinite(at)
    ? { ...identity, worktreeId, at }
    : null
}

/**
 * Every readable tombstone once (an exact repeat is the same deletion), and when more than the cap
 * remain, the newest by `at` in their sent order with `truncated` set.
 */
export function readSessionConversationRemovalList(value: unknown): {
  removals: RuntimeSessionConversationRemoval[]
  truncated: boolean
} {
  const removals: RuntimeSessionConversationRemoval[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    const removal = readSessionConversationRemoval(entry)
    const key = removal ? sessionConversationRemovalStampKey(removal) : ''
    if (removal && !seen.has(key)) {
      seen.add(key)
      removals.push(removal)
    }
  }
  if (removals.length <= MAX_REMOVALS) {
    return { removals, truncated: false }
  }
  // Why the newest: an older tombstone's row is the likeliest to be gone everywhere already.
  const kept = new Set(
    removals
      .map((removal, index) => ({ at: removal.at, index }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_REMOVALS)
      .map((entry) => entry.index)
  )
  return { removals: removals.filter((_, index) => kept.has(index)), truncated: true }
}

type SetRemovals = Pick<RuntimeSessionConversationLedger, 'removals' | 'removalsTruncated'>
type DeltaRemovals = Pick<RuntimeSessionConversationLedgerDelta, 'removals' | 'removalsTruncated'>

/**
 * The tombstones a whole set or a delta carries. A set always reads a list — absent reads as none,
 * which removes nothing; a delta carries one only when the owner sent it (absent: no removal since
 * its base revision). `removalsTruncated` when the owner said so or this read cut the list.
 */
export function readSessionConversationLedgerRemovals(
  raw: Record<string, unknown>,
  carrier: 'set'
): SetRemovals
export function readSessionConversationLedgerRemovals(
  raw: Record<string, unknown>,
  carrier: 'delta'
): DeltaRemovals
export function readSessionConversationLedgerRemovals(
  raw: Record<string, unknown>,
  carrier: 'set' | 'delta'
): DeltaRemovals {
  const read = readSessionConversationRemovalList(raw.removals)
  return {
    ...(carrier === 'set' || Array.isArray(raw.removals) ? { removals: read.removals } : {}),
    ...(read.truncated || raw.removalsTruncated === true
      ? { removalsTruncated: true as const }
      : {})
  }
}
