/**
 * A receiver's durable snapshot of one paired owner's conversation ledger and workflow records
 * (session parity, step 5; G1, G4, F24): what the window last reconciled for that owner, kept by
 * its own main process at `<userData>/session-host/ledgers/<environmentId>.json`, so a restart
 * while the owner is offline still lists the owner's conversations "as of <time>". Never sent to
 * another computer. A snapshot proves no absence: its readers force every workspace incomplete
 * (and a workflow set incomplete), and restoring one removes nothing.
 */

import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  readSessionConversationLedger,
  type RuntimeSessionConversationLedger
} from './session-conversation-ledger'
import { asObject } from './session-conversation-ledger-read-primitives'
import { isSessionHostId } from './session-host-identity'
import {
  readSessionWorkflowRecordSet,
  type RuntimeSessionWorkflowRecordSet
} from './session-workflow-records'

/** The window → its own main process: remember what it reconciled for one owner. */
export const REMEMBER_CONVERSATION_LEDGER_CHANNEL = 'runtime:rememberConversationLedger'

export type RememberConversationLedgerRequest = {
  environmentId: string
  /** G4: the owner's durable session-host journal id, when the window knows it. */
  ownerHostId?: string
  /** The reconciled ledger as a set; absent leaves what main keeps unchanged. */
  set?: RuntimeSessionConversationLedger
  /** Receipt time of the newest evidence `set` holds. */
  asOf?: number
  /** Workspaces whose newest evidence is older than `asOf`. */
  asOfByWorktree?: Record<string, number>
  /** F24: the reconciled workflow records; absent leaves what main keeps unchanged. */
  workflowRecords?: RuntimeSessionWorkflowRecordSet
  /** Receipt time of the newest live workflow evidence. */
  workflowsAsOf?: number
  /** Workspaces whose workflows were last confirmed live before `workflowsAsOf` (still "as of"). */
  workflowsAsOfByWorktree?: Record<string, number>
  /**
   * The change removed rows or captures, added tombstones or changed the catalog: main writes
   * it at once (C1: a quit soon after a deletion never restores it). Absent: it may wait for
   * its burst to settle. Never kept in the file.
   */
  urgent?: true
}

export type RemoteConversationLedgerSnapshot = RememberConversationLedgerRequest & {
  savedAt: number
}

/** `sessionHosts.ledgerSnapshots`: every kept snapshot (window-only). */
export type SessionHostsLedgerSnapshotsResult = { snapshots: RemoteConversationLedgerSnapshot[] }

// Why so narrow: it names a file; runtime environment ids are UUIDs.
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

export function isRemoteConversationLedgerEnvironmentId(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_ID.test(value)
}

function readTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readTimes(value: unknown): Record<string, number> | undefined {
  const raw = asObject(value)
  const entries = Object.entries(raw ?? {})
    .slice(0, SESSION_CONVERSATION_LEDGER_LIMITS.workspaces)
    .flatMap(([worktreeId, at]): [string, number][] => {
      const time = readTime(at)
      return worktreeId.length > 0 &&
        worktreeId.length <= SESSION_CONVERSATION_LEDGER_LIMITS.worktreeId &&
        time !== undefined
        ? [[worktreeId, time]]
        : []
    })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** Why incomplete everywhere: a remembered listing never stands for an absence (A5). */
function readSet(value: unknown): RuntimeSessionConversationLedger | undefined {
  const set = value === undefined ? undefined : readSessionConversationLedger(value)
  return set
    ? { ...set, coverage: set.coverage.map(({ worktreeId }) => ({ worktreeId, complete: false })) }
    : undefined
}

function readWorkflows(value: unknown): RuntimeSessionWorkflowRecordSet | undefined {
  const set = value === undefined ? undefined : readSessionWorkflowRecordSet(value)
  return set ? { ...set, complete: false } : undefined
}

/** A window's request, or null when it names no environment this computer could file. */
export function readRememberConversationLedgerRequest(
  value: unknown
): RememberConversationLedgerRequest | null {
  const raw = asObject(value)
  if (!raw || !isRemoteConversationLedgerEnvironmentId(raw.environmentId)) {
    return null
  }
  const set = readSet(raw.set)
  const asOf = readTime(raw.asOf)
  const asOfByWorktree = set ? readTimes(raw.asOfByWorktree) : undefined
  const workflowRecords = readWorkflows(raw.workflowRecords)
  const workflowsAsOf = readTime(raw.workflowsAsOf)
  const workflowsAsOfByWorktree = workflowRecords
    ? readTimes(raw.workflowsAsOfByWorktree)
    : undefined
  return {
    environmentId: raw.environmentId,
    ...(isSessionHostId(raw.ownerHostId) ? { ownerHostId: raw.ownerHostId } : {}),
    ...(set ? { set } : {}),
    ...(set && asOf !== undefined ? { asOf } : {}),
    ...(asOfByWorktree ? { asOfByWorktree } : {}),
    ...(workflowRecords ? { workflowRecords } : {}),
    ...(workflowRecords && workflowsAsOf !== undefined ? { workflowsAsOf } : {}),
    ...(workflowsAsOfByWorktree ? { workflowsAsOfByWorktree } : {}),
    ...(raw.urgent === true ? { urgent: true as const } : {})
  }
}

/** One kept snapshot read leniently: null when it is not one. */
export function readRemoteConversationLedgerSnapshot(
  value: unknown
): RemoteConversationLedgerSnapshot | null {
  const request = readRememberConversationLedgerRequest(value)
  const savedAt = readTime(asObject(value)?.savedAt)
  return request && savedAt !== undefined ? { ...request, savedAt } : null
}

export function readSessionHostsLedgerSnapshotsResult(
  value: unknown
): SessionHostsLedgerSnapshotsResult {
  const list = asObject(value)?.snapshots
  return {
    snapshots: (Array.isArray(list) ? list : []).flatMap(
      (entry) => readRemoteConversationLedgerSnapshot(entry) ?? []
    )
  }
}
