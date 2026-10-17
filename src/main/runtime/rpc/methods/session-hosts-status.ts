// `sessionHosts.status`: one reading per other computer that runs a session in the sidebar (Phase
// 4 E). Answers at once with what is known and starts a bounded reading of stale hosts, so the
// Work card and `omni session hosts` never wait on a computer that cannot be reached. Read-only;
// the window and the local CLI only.

import { z } from 'zod'
import {
  SESSION_HOSTS_RPC,
  type SessionHostsStatusResult
} from '../../../../shared/session-hosts-status'
import { isRemoteSessionRow } from '../../../session-host-remote/remote-session-manage'
import { getRemoteSessionHosts } from '../../../session-host-remote/remote-session-hosts-runtime'
import { getSessionHostPolicySync } from '../../../session-host-remote/session-host-policy-sync'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import {
  readOwnerLedgerStates,
  withOwnerLedgers
} from '../../../session-manage/session-parity-read'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationLocalReader } from './session-organization'

const StatusParams = z
  .object({
    /** Wait for the reading this call starts (the CLI); the Work card polls instead. */
    wait: z.boolean().optional()
  })
  .strict()
  .optional()

export const SESSION_HOSTS_STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_HOSTS_RPC.status,
    params: StatusParams,
    handler: async (params, context): Promise<SessionHostsStatusResult> => {
      assertOrganizationLocalReader(context)
      const policies = getSessionHostPolicySync()
      const synced = policies?.synced()
      const own = policies?.ownHostId() ?? null
      const shared = {
        switches: policies?.hostSwitches() ?? [],
        folderPolicies: policies?.folderPolicies() ?? {},
        thisHostOffElsewhere: own !== null && synced?.hosts[own]?.p.automation === 'off'
      }
      const hosts = getRemoteSessionHosts()
      if (!hosts) {
        return { hosts: [], refreshing: false, ...shared }
      }
      // Why tolerant: no window (a headless relaunch) lists no rows, so no other computers.
      const rows = await readSidebarRows(context.runtime).catch(() => [])
      const keys = rows.filter(isRemoteSessionRow).map((row) => row.hostId!)
      const reading = hosts.refresh(keys)
      if (params?.wait === true) {
        await reading
      } else {
        void reading.catch(() => {})
      }
      // Session parity (G2): each paired owner's ledger state beside its control state.
      const ledgers = keys.length > 0 ? await readOwnerLedgerStates(context.runtime) : []
      return {
        hosts: withOwnerLedgers(hosts.snapshots(keys), ledgers),
        refreshing: params?.wait !== true && keys.length > 0,
        ...shared
      }
    }
  })
]
