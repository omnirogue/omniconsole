import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  readSessionConversationRemoval,
  readSessionConversationRemovalList,
  sessionConversationListedRemovalKeys,
  sessionConversationRemovalKey,
  sessionConversationRemovalStampKey,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationRemoval
} from '../../shared/session-conversation-ledger'

/** How long the owner keeps a tombstone: from its deletion, or from when it showed again. */
export const CONVERSATION_REMOVAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

type RecordsByWorktree = RuntimeSessionConversationLedger['recordsByWorktree']
type Entry = {
  /** As the provider sent it: `at` is the durable deletion stamp. */
  removal: RuntimeSessionConversationRemoval
  /** `sessionConversationRemovalStampKey`: one tombstone exactly (identity, workspace, time). */
  key: string
  /** A record the shown set lists names it, so no snapshot carries it now. */
  shielded: boolean
  /** The revision since which snapshots show it; meaningless while shielded. */
  revision: number
  /** Past retention by its stamp: kept only while held back or within retention of `reshownAt`. */
  aged: boolean
  /** When it last went from held back to shown: its published `at` and retention run from it. */
  reshownAt?: number
}

const sameKeys = (a: readonly Entry[], b: readonly Entry[]): boolean => {
  const keys = new Set(a.map((entry) => entry.key))
  return a.length === b.length && b.every((entry) => keys.has(entry.key))
}
const shownOf = (entries: readonly Entry[]): Entry[] => entries.filter((entry) => !entry.shielded)

/** The tombstone snapshots carry: `at` is the later of the deletion and its last showing again. */
function published(entry: Entry): RuntimeSessionConversationRemoval {
  const at = Math.max(entry.removal.at, entry.reshownAt ?? entry.removal.at)
  return at === entry.removal.at ? entry.removal : { ...entry.removal, at }
}

/** Whether two shown lists carry the same tombstones, in any order. */
const samePublished = (a: readonly Entry[], b: readonly Entry[]): boolean => {
  const key = (entry: Entry) => sessionConversationRemovalStampKey(published(entry))
  const keys = new Set(a.map(key))
  return a.length === b.length && b.every((entry) => keys.has(key(entry)))
}

/** Judges an entry against the listed keys: going from held back to shown stamps it anew. */
function judged(entry: Entry, listed: ReadonlySet<string>, nextRevision: number, now: number) {
  const shielded = listed.has(sessionConversationRemovalKey(entry.removal))
  if (shielded === entry.shielded) {
    return entry
  }
  return shielded
    ? { ...entry, shielded }
    : { ...entry, shielded, revision: nextRevision, reshownAt: now }
}

/**
 * The owner store's retained tombstones (session parity integration): the list step 3's provider
 * sets, less every tombstone a record of the shown set lists (`sessionConversationListedRemovalKeys`),
 * each stamped with the revision since which snapshots show it. Why: the durable delete mark
 * outlives a reopened tab, which the sidebar lists again, and the provider hears a delete before
 * the publisher drops the row, so without this one set could list and tombstone one conversation.
 * Listed evidence wins; a held-back tombstone shows again, stamped anew, once no listed record
 * names it — published with `at` = that moment and kept 90 days from it, even when its deletion is
 * older (the provider hands such `aged` deletions over too), so a peer that missed the window's
 * set still removes a conversation hidden again long after it was deleted (F4). Nothing shows,
 * not even the cut marker, until this runtime incarnation publishes its first set (`release`):
 * before it no set has listed what that set would hold back, and a receiver acts on a tombstone
 * whatever the coverage. A set read back from owner-ledger.json is a stale fallback, never that
 * first set.
 */
export class SessionConversationLedgerRemovals {
  private entries: Entry[] = []
  private truncated = false
  private released = false

  /**
   * Replaces the retained list, judged against the shown set's records; `nextRevision` stamps what
   * newly shows. `aged`: deletions past retention by their stamp, kept only while held back or
   * within retention of their showing again. True when what a snapshot shows changed.
   */
  set(
    removals: RuntimeSessionConversationRemoval[],
    truncated: boolean,
    records: RecordsByWorktree,
    nextRevision: number,
    now: number,
    aged: readonly RuntimeSessionConversationRemoval[] = []
  ): boolean {
    const read = readSessionConversationRemovalList(removals)
    const listed = sessionConversationListedRemovalKeys(records)
    const prior = new Map(this.entries.map((entry) => [entry.key, entry]))
    const entry = (removal: RuntimeSessionConversationRemoval, isAged: boolean): Entry => {
      const key = sessionConversationRemovalStampKey(removal)
      const shielded = listed.has(sessionConversationRemovalKey(removal))
      const known = prior.get(key)
      const revision = known && !known.shielded && !shielded ? known.revision : nextRevision
      const reshownAt = known?.reshownAt
      return {
        removal,
        key,
        shielded,
        revision,
        aged: isAged,
        ...(reshownAt !== undefined ? { reshownAt } : {})
      }
    }
    const fresh = read.removals.map((removal) => entry(removal, false))
    const freshKeys = new Set(fresh.map((candidate) => candidate.key))
    const kept = aged.flatMap((value) => {
      const removal = readSessionConversationRemoval(value)
      const candidate = removal ? entry(removal, true) : null
      const retained =
        candidate !== null &&
        (candidate.shielded ||
          (candidate.reshownAt ?? -Infinity) >= now - CONVERSATION_REMOVAL_RETENTION_MS)
      return retained && !freshKeys.has(candidate.key) ? [candidate] : []
    })
    const next = [...fresh, ...kept]
    const nextTruncated = truncated || read.truncated
    // Why kept as is: the same tombstones in another order change nothing a snapshot shows.
    if (nextTruncated === this.truncated && sameKeys(this.entries, next)) {
      return false
    }
    const before = this.visible()
    this.entries = next
    this.truncated = nextTruncated
    const after = this.visible()
    return before.truncated !== after.truncated || !samePublished(before.entries, after.entries)
  }

  /**
   * This incarnation's first set went out: every retained tombstone its records do not list shows,
   * stamped at that set's `nextRevision`, so the next delta carries it. True when anything shows.
   */
  release(records: RecordsByWorktree, nextRevision: number, now: number): boolean {
    if (this.released) {
      return false
    }
    this.released = true
    const listed = sessionConversationListedRemovalKeys(records)
    this.entries = this.entries.map((entry) => ({
      ...judged(entry, listed, nextRevision, now),
      revision: nextRevision
    }))
    const shown = this.visible()
    return shown.truncated || shown.entries.length > 0
  }

  /** Re-judges every tombstone against a newly shown set, before that set's `nextRevision`. */
  shield(records: RecordsByWorktree, nextRevision: number, now: number): void {
    const listed = sessionConversationListedRemovalKeys(records)
    this.entries = this.entries.map((entry) => judged(entry, listed, nextRevision, now))
  }

  shown(): RuntimeSessionConversationRemoval[] {
    return this.visible().entries.map(published)
  }

  /** Every tombstone snapshots show that they did not show at `revision` or before. */
  shownSince(revision: number): RuntimeSessionConversationRemoval[] {
    return this.visible()
      .entries.filter((entry) => entry.revision > revision)
      .map(published)
  }

  isTruncated(): boolean {
    return this.visible().truncated
  }

  /**
   * What snapshots show: nothing before the first set, then every tombstone not held back — the
   * newest SESSION_CONVERSATION_LEDGER_LIMITS.removals by published `at`, in order, when more.
   */
  private visible(): { entries: Entry[]; truncated: boolean } {
    if (!this.released) {
      return { entries: [], truncated: false }
    }
    const entries = shownOf(this.entries)
    const max = SESSION_CONVERSATION_LEDGER_LIMITS.removals
    if (entries.length <= max) {
      return { entries, truncated: this.truncated }
    }
    const newest = new Set(
      [...entries].sort((a, b) => published(b).at - published(a).at).slice(0, max)
    )
    return { entries: entries.filter((entry) => newest.has(entry)), truncated: true }
  }
}
