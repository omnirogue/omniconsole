// `sessionHosts.ledgerSnapshots`: this computer's durable receiver snapshots of paired owners'
// conversation ledgers and workflow records (session parity, step 5). The window reads them once
// on start and lists an offline owner's conversations "as of <time>"; they never retire anything.
// Window-only: a snapshot is this window's own reconciled view, not evidence for any other client.

import type { SessionHostsLedgerSnapshotsResult } from '../../../../shared/remote-conversation-ledger-snapshot'
import { SESSION_HOSTS_RPC } from '../../../../shared/session-hosts-status'
import { getRemoteConversationLedgerStore } from '../../../session-host-remote/remote-conversation-ledger-runtime'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationWindowCaller } from './session-organization'

export const SESSION_HOSTS_LEDGER_SNAPSHOT_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_HOSTS_RPC.ledgerSnapshots,
    params: null,
    handler: async (_params, context): Promise<SessionHostsLedgerSnapshotsResult> => {
      assertOrganizationWindowCaller(context)
      return { snapshots: await getRemoteConversationLedgerStore().snapshots() }
    }
  })
]
