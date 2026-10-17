// Pure ordering and evidence decisions for an owner's mirrored sets (session counts, step 9;
// generalised for the conversation ledger, session parity step 5): whether one owner's whole set
// or delta is newer than what this receiver holds, and what it does to that owner's workspace
// buckets. Records reconcile by an identity the carrier names, and completeness is per workspace,
// so one message can replace a workspace whole and only add to another. The workflow carrier
// (mirrored-workflow-block-decision.ts) is one owner-wide-completeness adapter over this.

/** The last set (or delta) this receiver accepted from one owner. */
export type MirroredOwnerOrder = { generation: string; revision: number; complete: boolean }

export type MirroredOwnerDecision =
  | { apply: true; reason: string; retire?: string }
  | { apply: false; reason: string }

type Ordered = { generation: string; revision: number }

/**
 * Whether to take an owner's whole set. Within one generation only a higher revision is newer, so
 * a late copy never restores what a newer set removed. A different generation (the owner
 * restarted) is taken only from a fresh connection's initial inventory, which retires the old
 * one; on a running connection it is ignored, as step 3 orders inventory generations.
 */
export function decideMirroredOwnerSet(args: {
  current: MirroredOwnerOrder | undefined
  set: Ordered | undefined
  /** The set opens a fresh connection (its initial listAll or subscribeAll inventory). */
  fresh: boolean
  retiredGenerations?: ReadonlySet<string>
  /** The carrier's reason for an absent set (an older owner says nothing: unknown). */
  absentReason?: string
}): MirroredOwnerDecision {
  const { current, set } = args
  if (!set) {
    return { apply: false, reason: args.absentReason ?? 'no-set' }
  }
  if (args.retiredGenerations?.has(set.generation)) {
    return { apply: false, reason: 'retired-generation' }
  }
  if (!current) {
    return { apply: true, reason: 'first-set' }
  }
  if (set.generation === current.generation) {
    return set.revision > current.revision
      ? { apply: true, reason: 'newer-revision' }
      : {
          apply: false,
          reason: set.revision === current.revision ? 'same-revision' : 'older-revision'
        }
  }
  return args.fresh
    ? { apply: true, reason: 'new-generation-on-fresh-connection', retire: current.generation }
    : { apply: false, reason: 'generation-change-mid-connection' }
}

const MAX_RETIRED_GENERATIONS = 32

/** Fences a generation an owner moved past, keeping the newest few per environment. */
export function rememberRetiredGeneration(
  retiredByEnvironment: Map<string, Set<string>>,
  environmentId: string,
  generation: string
): void {
  const retired = retiredByEnvironment.get(environmentId) ?? new Set<string>()
  retired.add(generation)
  if (retired.size > MAX_RETIRED_GENERATIONS) {
    retired.delete(retired.values().next().value as string)
  }
  retiredByEnvironment.set(environmentId, retired)
}

/**
 * Whether to take a streamed delta: only on top of a state of the same generation at least as new
 * as its base, and only when it is newer. Anything else is ignored; the stream's next inventory
 * brings the whole set.
 */
export function decideMirroredOwnerDelta(args: {
  current: MirroredOwnerOrder | undefined
  delta: Ordered & { baseRevision: number }
  retiredGenerations?: ReadonlySet<string>
  /** Workflow deltas only ever follow a complete set; a ledger delta may follow any set. */
  requireCompleteBase: boolean
}): MirroredOwnerDecision {
  const { current, delta } = args
  if (args.retiredGenerations?.has(delta.generation)) {
    return { apply: false, reason: 'retired-generation' }
  }
  // Why: a ledger stream whose inventory carried a revision-0 set (nothing published yet, read
  // as no ledger) delivers the owner's first publication as a delta on base 0 — a delta on an
  // empty set, which is the whole set. Taking it is the same as taking that empty set first.
  if (!current && !args.requireCompleteBase && delta.baseRevision === 0) {
    return { apply: true, reason: 'delta-on-empty-base' }
  }
  if (
    !current ||
    current.generation !== delta.generation ||
    (args.requireCompleteBase && !current.complete)
  ) {
    return {
      apply: false,
      reason: args.requireCompleteBase ? 'delta-without-complete-base' : 'delta-without-base'
    }
  }
  if (delta.revision <= current.revision) {
    return {
      apply: false,
      reason: delta.revision === current.revision ? 'same-revision' : 'older-revision'
    }
  }
  return current.revision >= delta.baseRevision
    ? { apply: true, reason: 'delta' }
    : { apply: false, reason: 'delta-base-missing' }
}

/** How a carrier names its records: one identity each, plus identities a listed one supersedes. */
export type MirroredOwnerIdentity<R> = {
  key: (record: R) => string
  /** Further identities a listed record replaces (the provider-less row of its own pane). */
  replaces?: (record: R) => readonly string[]
  /**
   * The one slot a record fills (a tab-surface record's owner pane), or null. A listed record
   * supersedes any kept record in its slot whatever that record's identity: a pane runs one
   * conversation at a time, so the old one's claim to it is proven false even where the
   * workspace proves no absence.
   */
  slot?: (record: R) => string | null
}

export type MirroredOwnerBuckets<R> = readonly { worktreeId: string; records: readonly R[] }[]

export type MirroredOwnerApplication<R> = {
  /** Each workspace's records after the message, empty lists included. */
  recordsByWorktree: Map<string, R[]>
  /** Identities removed because a workspace taken whole omitted them. */
  removed: string[]
  /** Identities omitted where the message proves no absence, so kept. */
  retained: string[]
  /** Identities omitted whose slot a listed record now fills, so dropped. */
  superseded: string[]
}

/**
 * One owner's records after a message. `listed` holds each workspace the message names, with its
 * whole list. A workspace `replacesWhole` approves takes exactly that list: whatever it omits is
 * removed. Any other keeps what it had minus records listed again anywhere (moved or superseded)
 * and minus records whose slot a listed record fills, then adds what it lists. A `'delta'` leaves
 * workspaces it does not name untouched; a `'set'` speaks for every workspace, so it also takes
 * listed records out of the ones it does not name.
 */
export function applyMirroredOwnerRecords<R>(args: {
  current: MirroredOwnerBuckets<R>
  listed: Readonly<Record<string, readonly R[]>>
  replacesWhole: (worktreeId: string) => boolean
  scope: 'set' | 'delta'
  identity: MirroredOwnerIdentity<R>
}): MirroredOwnerApplication<R> {
  const { identity } = args
  const listedEntries = Object.entries(args.listed)
  const listedKeys = new Set<string>()
  const listedSlots = new Set<string>()
  for (const [, records] of listedEntries) {
    for (const record of records) {
      listedKeys.add(identity.key(record))
      for (const replaced of identity.replaces?.(record) ?? []) {
        listedKeys.add(replaced)
      }
      const slot = identity.slot?.(record)
      if (slot) {
        listedSlots.add(slot)
      }
    }
  }
  const out = new Map<string, R[]>()
  const removed: string[] = []
  const retained: string[] = []
  const superseded: string[] = []
  for (const bucket of args.current) {
    if (args.scope === 'delta' && !Object.hasOwn(args.listed, bucket.worktreeId)) {
      out.set(bucket.worktreeId, [...bucket.records])
      continue
    }
    const omitted = bucket.records.filter((record) => !listedKeys.has(identity.key(record)))
    if (args.replacesWhole(bucket.worktreeId)) {
      removed.push(...omitted.map(identity.key))
      out.set(bucket.worktreeId, [])
      continue
    }
    const kept: R[] = []
    for (const record of omitted) {
      const slot = identity.slot?.(record)
      if (slot && listedSlots.has(slot)) {
        superseded.push(identity.key(record))
      } else {
        kept.push(record)
      }
    }
    retained.push(...kept.map(identity.key))
    out.set(bucket.worktreeId, kept)
  }
  for (const [worktreeId, records] of listedEntries) {
    out.set(worktreeId, [...(out.get(worktreeId) ?? []), ...records])
  }
  return { recordsByWorktree: out, removed, retained, superseded }
}
