/**
 * `omni session ledger [--host <runtime>]` (session parity, addendum F19): a main-side read that
 * needs no window. Without `--host`, this computer's own conversation ledger exactly as its paired
 * computers receive it now (window- or main-authored); with `--host runtime:<id>`, what this
 * computer last reconciled of that owner's ledger (its durable receiver snapshot, "as of"). Each
 * record is reported as a parity row (session-parity.ts), so a parity check reads either source the
 * way it reads `sidebar-counts --json`. Read-only.
 */

import type {
  RuntimeSessionConversationLedger,
  RuntimeSessionConversationRecord,
  SessionConversationLedgerCoverage,
  SessionConversationLedgerSource
} from './session-conversation-ledger'
import {
  sessionParityRecordIdentity,
  type SessionParityRow,
  type SessionParityVerification
} from './session-parity'

export const SESSION_LEDGER_RPC = 'session.ledger'

/** One ledger record as a parity row; `archived` is null when the owner did not say (tri-state). */
export type SessionLedgerReadRow = Omit<SessionParityRow, 'archived'> & { archived: boolean | null }

export type SessionLedgerReadResult = {
  /** `local` for this computer's own ledger, else the paired owner's `runtime:<id>`. */
  hostId: string
  /**
   * `owner`: this computer's ledger as served now; `receiver-snapshot`: this computer's kept copy
   * of a paired owner's; `none`: no ledger (an older build, or never received from that owner).
   */
  source: 'owner' | 'receiver-snapshot' | 'none'
  generation: string | null
  revision: number | null
  /** Who authored the set: the owner's window, or its main process from persistence. */
  ledgerSource: SessionConversationLedgerSource | null
  /** Own ledger: whether a window publishes it now (otherwise main authored it). */
  windowCurrent?: boolean
  listedAt: number | null
  /** Receiver snapshot: receipt time of its newest evidence, and when it was written. */
  asOf?: number | null
  savedAt?: number
  coverage: SessionConversationLedgerCoverage[]
  removals: number
  removalsTruncated?: true
  rows: SessionLedgerReadRow[]
  counts: { ownerListed: number; heldByOwner: number; archived: number }
  /** Own ledger only: the paired owners this computer keeps a snapshot of (for `--host`). */
  receivers?: { hostId: string; savedAt: number }[]
  readAt: number
}

function readRow(
  hostId: string,
  worktreeId: string,
  record: RuntimeSessionConversationRecord,
  verification: SessionParityVerification
): SessionLedgerReadRow {
  return {
    hostId,
    worktreeId,
    kind: 'terminal',
    agent: record.agent,
    archived: record.archived ? record.archived.archived : null,
    label: record.title,
    bucket: record.listed ? 'ownerListed' : 'heldByOwner',
    verification,
    identity: sessionParityRecordIdentity(record),
    conversation: record.conversation,
    ...(record.paneIdentity ? { paneIdentity: record.paneIdentity } : {}),
    rest: record.rest,
    ...(verification === 'stale' ? { stale: true as const } : {})
  }
}

/** A set's records as parity rows under `hostId`, with its counts. */
export function sessionLedgerReadRows(
  set: RuntimeSessionConversationLedger,
  hostId: string,
  verification: SessionParityVerification
): Pick<SessionLedgerReadResult, 'rows' | 'counts'> {
  const rows = Object.entries(set.recordsByWorktree)
    .flatMap(([worktreeId, records]) =>
      records.map((record) => readRow(hostId, worktreeId, record, verification))
    )
    .sort(
      (a, b) =>
        a.worktreeId.localeCompare(b.worktreeId) ||
        (a.identity ?? '').localeCompare(b.identity ?? '')
    )
  return {
    rows,
    counts: {
      ownerListed: rows.filter((row) => row.bucket === 'ownerListed').length,
      heldByOwner: rows.filter((row) => row.bucket === 'heldByOwner').length,
      archived: rows.filter((row) => row.archived === true).length
    }
  }
}
