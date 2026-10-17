/** `omni session hosts`: one `sessionHosts.status` call, waiting for this call's reading. */

import { SESSION_HOSTS_RPC, type SessionHostsStatusResult } from '../../shared/session-hosts-status'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { formatSessionHosts } from '../session-hosts-format'
import { refuseRemote } from './session-manage-access'

// Why this long: up to three hosts are read at once, each bounded by its transport (30 s).
const HOSTS_TIMEOUT_MS = 120_000

export const SESSION_HOSTS_HANDLERS: Record<string, CommandHandler> = {
  'session hosts': async ({ client, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionHostsStatusResult>(
      SESSION_HOSTS_RPC.status,
      { wait: true },
      { timeoutMs: HOSTS_TIMEOUT_MS }
    )
    printResult(response, json, formatSessionHosts)
  }
}
