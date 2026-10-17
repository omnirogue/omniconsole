/**
 * Like-for-like session counts across paired computers (session parity, step 8; addendum C5, F7,
 * F21, grafts G1 and G2). Every sidebar row on every computer gets one classification: whose list
 * it is on (`bucket`) and how sure this computer is of it (`verification`), with the tagged identity
 * both computers name it by. `omni session sidebar-counts --json` and `omni session list --json`
 * carry these fields identically on their rows and export the same UNFILTERED canonical population
 * (every row, before tag, agent and routine filters, deleted rows aside); what the sidebar shows
 * stays its own, separately reported count. Read-only and additive: an older window omits all of it.
 */

import type {
  SessionConversationLedgerSource,
  SessionConversationRest
} from './session-conversation-ledger'

/**
 * - `ownerListed`: the owner's conversation ledger lists it. On the owner itself that is the
 *   ledger's own eligibility rule (F7); its SSH and chat rows, which no ledger carries, are its own
 *   list too.
 * - `heldByOwner`: a capture the owner vouches for without listing it (passive evidence, G1).
 *   Shown apart, never a mismatch.
 * - `receiverOnly`: only this computer lists it; no current owner list names it.
 * - `workflow`: a workflow conversation, carried by workflow records rather than the ledger.
 */
export const SESSION_PARITY_BUCKETS = [
  'ownerListed',
  'heldByOwner',
  'receiverOnly',
  'workflow'
] as const
export type SessionParityBucket = (typeof SESSION_PARITY_BUCKETS)[number]

/**
 * - `verified`: its owner's word on it is current.
 * - `stale`: listed as last known — a restored snapshot, or an owner out of reach.
 * - `unverified`: nothing current vouches for it: the row's "can't verify" label, the owner's own
 *   quarantine, an older owner, or an owner list that may be missing deletions.
 */
export const SESSION_PARITY_VERIFICATIONS = ['verified', 'unverified', 'stale'] as const
export type SessionParityVerification = (typeof SESSION_PARITY_VERIFICATIONS)[number]

/** One row's classification, under the same names wherever a row is reported. */
export type SessionParityFields = {
  bucket: SessionParityBucket
  verification: SessionParityVerification
  /**
   * F21: `c:<digest>` when a provider session is known, else `p:pane:<owner paneKey>`, or
   * `w:<workflow anchor tab>` for a workflow; null while a row has none of them (a launch in flight).
   */
  identity: string | null
  /** The owner's full-claim digest (sessionConversationIdentity); null with no provider session. */
  conversation: string | null
  /** `pane:<owner paneKey>`, whenever the owner's pane is known. */
  paneIdentity?: string
  /** What the owner's ledger says of it: live, dormant, asleep or unknown. */
  rest?: SessionConversationRest
  /** Restored from this computer's durable snapshot and not confirmed live since ("as of"). */
  stale?: true
  /** Why it is `receiverOnly` or not verified, when there is a reason to name. */
  bucketReason?: string
}

/** One row of the canonical parity population. */
export type SessionParityRow = SessionParityFields & {
  /** The host the sidebar counts it under: its display host, else its execution host, else `unknown`. */
  hostId: string
  worktreeId: string
  kind: 'terminal' | 'structured'
  agent: string
  /** Archived as this computer resolves it (the owner's explicit mark first, C3). */
  archived: boolean
  label: string
}

/** Within one host: count = ownerListed + heldByOwner + receiverOnly + workflow. */
export type SessionParityBucketCounts = {
  ownerListed: number
  heldByOwner: number
  receiverOnly: number
  workflow: number
  /** Counted within the buckets above, never on top of them. */
  unverified: number
  stale: number
  archived: number
}

export type SessionParityHostCount = { hostId: string; count: number } & SessionParityBucketCounts

/** G2: what this computer knows of one paired owner's conversation ledger. */
export type SessionOwnerLedgerState = {
  /** `runtime:<environmentId>`: the host its rows carry. */
  hostId: string
  generation: string | null
  revision: number | null
  source: SessionConversationLedgerSource | null
  state: 'ready' | 'stale' | 'older' | 'unreachable'
  /** Receipt time of the newest set or delta applied (or of the restored snapshot). */
  asOf?: number | null
}

export type SessionParityPopulation = {
  rows: SessionParityRow[]
  countsByHost: SessionParityHostCount[]
  ownerLedgers: SessionOwnerLedgerState[]
}

export type SessionParityCountInput = Pick<SessionParityFields, 'bucket' | 'verification'> & {
  archived?: boolean
}

/** F21: the tagged identity of a ledger record (`c:` / `p:`); null when it carries neither. */
export function sessionParityRecordIdentity(record: {
  conversation: string | null
  paneIdentity?: string
}): string | null {
  return record.conversation
    ? `c:${record.conversation}`
    : record.paneIdentity
      ? `p:${record.paneIdentity}`
      : null
}

export function emptySessionParityBucketCounts(): SessionParityBucketCounts {
  return {
    ownerListed: 0,
    heldByOwner: 0,
    receiverOnly: 0,
    workflow: 0,
    unverified: 0,
    stale: 0,
    archived: 0
  }
}

export function addSessionParityCount(
  counts: SessionParityBucketCounts,
  row: SessionParityCountInput
): void {
  counts[row.bucket] += 1
  if (row.verification !== 'verified') {
    counts[row.verification] += 1
  }
  if (row.archived) {
    counts.archived += 1
  }
}

/** The "+N only here (can't verify)" rows: listed here, and nothing current vouches for them. */
export function isSessionParityOnlyHere(
  row: Pick<SessionParityFields, 'bucket' | 'verification'>
): boolean {
  return row.bucket === 'receiverOnly' && row.verification === 'unverified'
}

/** The classification fields of any row that carries them, in one order; {} from an older window. */
export function pickSessionParityFields(
  row: Partial<SessionParityFields>
): Partial<SessionParityFields> {
  if (!row.bucket || !row.verification) {
    return {}
  }
  return {
    bucket: row.bucket,
    verification: row.verification,
    identity: row.identity ?? null,
    conversation: row.conversation ?? null,
    ...(row.paneIdentity ? { paneIdentity: row.paneIdentity } : {}),
    ...(row.rest ? { rest: row.rest } : {}),
    ...(row.stale ? { stale: true as const } : {}),
    ...(row.bucketReason ? { bucketReason: row.bucketReason } : {})
  }
}

/** One population row, keys in one order whichever list it was read from. */
export function sessionParityRow(row: SessionParityRow): SessionParityRow {
  return {
    hostId: row.hostId,
    worktreeId: row.worktreeId,
    kind: row.kind,
    agent: row.agent,
    archived: row.archived,
    label: row.label,
    ...(pickSessionParityFields(row) as SessionParityFields)
  }
}

function rowOrder(a: SessionParityRow, b: SessionParityRow): number {
  return (
    a.hostId.localeCompare(b.hostId) ||
    a.worktreeId.localeCompare(b.worktreeId) ||
    (a.identity ?? '').localeCompare(b.identity ?? '') ||
    a.label.localeCompare(b.label)
  )
}

/** The canonical population: sorted rows and per-host bucket counts, owner states beside them. */
export function sessionParityPopulation(
  rows: readonly SessionParityRow[],
  ownerLedgers: readonly SessionOwnerLedgerState[]
): SessionParityPopulation {
  const sorted = rows.map(sessionParityRow).sort(rowOrder)
  const byHost = new Map<string, SessionParityHostCount>()
  for (const row of sorted) {
    const entry = byHost.get(row.hostId) ?? {
      hostId: row.hostId,
      count: 0,
      ...emptySessionParityBucketCounts()
    }
    entry.count += 1
    addSessionParityCount(entry, row)
    byHost.set(row.hostId, entry)
  }
  return {
    rows: sorted,
    countsByHost: [...byHost.values()],
    ownerLedgers: [...ownerLedgers].sort((a, b) => a.hostId.localeCompare(b.hostId))
  }
}
