/** `omni session relocate`: one `sessionManage.relocate` call; the runtime keeps it alive. */

import {
  SESSION_RELOCATE_RPC,
  type SessionRelocationResult
} from '../../shared/session-relocation-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatSessionRelocation } from '../session-relocate-format'
import { explicitTarget, refuseRemote } from './session-manage-access'
import { sessionProvenance } from './session-provenance-flags'

// Why this long: stopping, copying, staging and resuming each wait on a computer; keepalives
// refresh the budget while a step waits.
const RELOCATE_TIMEOUT_MS = 30 * 60_000
const DONE = new Set(['relocated', 'planned', 'proposed'])

export const SESSION_RELOCATE_HANDLERS: Record<string, CommandHandler> = {
  'session relocate': async ({ client, flags, json }) => {
    refuseRemote(client)
    const to = getRequiredStringFlag(flags, 'to')
    const workspace = getRequiredStringFlag(flags, 'workspace')
    const commit = getOptionalStringFlag(flags, 'commit')
    const relocation = getOptionalStringFlag(flags, 'continue')
    const target = await explicitTarget(client, flags)
    const response = await client.call<SessionRelocationResult>(
      SESSION_RELOCATE_RPC,
      {
        target,
        to,
        workspace,
        ...(commit ? { commit } : {}),
        ...(relocation ? { relocation } : {}),
        ...sessionProvenance(flags)
      },
      { timeoutMs: RELOCATE_TIMEOUT_MS }
    )
    printResult(response, json, formatSessionRelocation)
    if (!DONE.has(response.result.outcome)) {
      process.exitCode = 1
    }
  }
}
