// `session.ledger` (session parity, addendum F19): `omni session ledger [--host <runtime>]`. This
// computer's own conversation ledger exactly as its paired computers receive it now, or what it
// last reconciled of a paired owner's (its durable receiver snapshot, "as of"). Main-side, so it
// answers with no window (a headless relaunch) — when `sidebar-counts` cannot. Local CLI only;
// read-only.

import { z } from 'zod'
import type { RemoteConversationLedgerSnapshot } from '../../../../shared/remote-conversation-ledger-snapshot'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  SESSION_LEDGER_RPC,
  sessionLedgerReadRows,
  type SessionLedgerReadResult
} from '../../../../shared/session-ledger-read'
import type { SessionConversationLedgerStore } from '../../../runtime/session-conversation-ledger-store'
import { getRemoteConversationLedgerStore } from '../../../session-host-remote/remote-conversation-ledger-runtime'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationLocalReader } from './session-organization'

const LedgerParams = z
  .object({
    /** `local` (the default) or a paired owner's `runtime:<id>`. */
    host: z.string().min(1).max(512).optional()
  })
  .strict()
  .optional()

const NO_COUNTS = { ownerListed: 0, heldByOwner: 0, archived: 0 }

function noLedger(hostId: string): SessionLedgerReadResult {
  return {
    hostId,
    source: 'none',
    generation: null,
    revision: null,
    ledgerSource: null,
    listedAt: null,
    coverage: [],
    removals: 0,
    rows: [],
    counts: NO_COUNTS,
    readAt: Date.now()
  }
}

function ownLedger(
  store: SessionConversationLedgerStore,
  snapshots: readonly RemoteConversationLedgerSnapshot[]
): SessionLedgerReadResult {
  const set = store.snapshot()
  const receivers = snapshots
    .filter((snapshot) => snapshot.set)
    .map((snapshot) => ({
      hostId: toRuntimeExecutionHostId(snapshot.environmentId),
      savedAt: snapshot.savedAt
    }))
    .sort((a, b) => a.hostId.localeCompare(b.hostId))
  return {
    hostId: 'local',
    // Why revision 0 is none: nothing has been listed since this runtime started (no window yet
    // and no main-authored set), which is not an empty ledger.
    source: set.revision === 0 ? 'none' : 'owner',
    generation: set.generation,
    revision: set.revision,
    ledgerSource: set.source,
    windowCurrent: store.isWindowCurrent(),
    listedAt: set.listedAt,
    coverage: set.coverage,
    removals: set.removals.length,
    ...(set.removalsTruncated ? { removalsTruncated: true as const } : {}),
    ...sessionLedgerReadRows(set, 'local', 'verified'),
    receivers,
    readAt: Date.now()
  }
}

function receiverLedger(
  environmentId: string,
  snapshots: readonly RemoteConversationLedgerSnapshot[]
): SessionLedgerReadResult {
  const hostId = toRuntimeExecutionHostId(environmentId)
  const snapshot = snapshots.find((entry) => entry.environmentId === environmentId)
  const set = snapshot?.set
  if (!snapshot || !set) {
    return noLedger(hostId)
  }
  return {
    hostId,
    source: 'receiver-snapshot',
    generation: set.generation,
    revision: set.revision,
    ledgerSource: set.source,
    listedAt: set.listedAt,
    asOf: snapshot.asOf ?? null,
    savedAt: snapshot.savedAt,
    coverage: set.coverage,
    removals: set.removals.length,
    ...(set.removalsTruncated ? { removalsTruncated: true as const } : {}),
    // Why stale: a kept copy proves nothing current, whoever wrote it and however recently.
    ...sessionLedgerReadRows(set, hostId, 'stale'),
    readAt: Date.now()
  }
}

export const SESSION_LEDGER_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_LEDGER_RPC,
    params: LedgerParams,
    handler: async (params, context): Promise<SessionLedgerReadResult> => {
      assertOrganizationLocalReader(context)
      const snapshots = await getRemoteConversationLedgerStore().snapshots()
      const host = parseExecutionHostId(params?.host ?? 'local')
      if (host?.kind === 'local') {
        return ownLedger(context.runtime.getSessionConversationLedgerStore(), snapshots)
      }
      // Why none for an SSH host: no ledger carries those sessions (they are this computer's own).
      return host?.kind === 'runtime'
        ? receiverLedger(host.environmentId, snapshots)
        : noLedger(params?.host ?? 'unknown')
    }
  })
]
