/** `omni session ledger [--host <runtime>]` (session parity, addendum F19): main's ledger read. */

import { SESSION_LEDGER_RPC, type SessionLedgerReadResult } from '../../shared/session-ledger-read'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { refuseRemote } from './session-manage-access'
import { parseHost } from './session-host-flag'

function at(time: number | null | undefined): string {
  return time ? new Date(time).toISOString() : 'never'
}

export function formatSessionLedger(result: SessionLedgerReadResult): string {
  if (result.source === 'none') {
    return result.hostId === 'local'
      ? 'No conversation ledger yet: this computer has listed nothing since it started.'
      : `No ledger kept for ${result.hostId}: it never sent one here (or runs an older OmniConsole).`
  }
  const complete = result.coverage.filter((entry) => entry.complete).length
  const lines = [
    result.source === 'owner'
      ? `This computer's ledger, as its paired computers receive it now (${result.windowCurrent ? 'from its window' : 'main-authored: no window publishing'})`
      : `${result.hostId}'s ledger as this computer last reconciled it (as of ${at(result.asOf ?? result.savedAt)})`,
    `Generation ${result.generation ?? '?'}, revision ${result.revision ?? '?'}, ${result.ledgerSource ?? '?'}-authored, listed ${at(result.listedAt)}`,
    `Owner-listed: ${result.counts.ownerListed} · held by owner: ${result.counts.heldByOwner} · archived: ${result.counts.archived}`,
    `Workspaces: ${result.coverage.length} (${complete} complete) · deletions kept: ${result.removals}${result.removalsTruncated ? ' (cut: older ones missing)' : ''}`,
    ...(result.receivers?.length
      ? [`Kept from paired owners: ${result.receivers.map((entry) => entry.hostId).join(', ')}`]
      : [])
  ]
  return lines.join('\n')
}

export const SESSION_LEDGER_HANDLERS: Record<string, CommandHandler> = {
  'session ledger': async ({ client, flags, json }) => {
    refuseRemote(client)
    const host = parseHost(getOptionalStringFlag(flags, 'host'))
    if (host?.startsWith('ssh:')) {
      throw new RuntimeClientError(
        'invalid_argument',
        "An SSH host has no conversation ledger: its sessions are this computer's own. Use --host local or runtime:<id>."
      )
    }
    const response = await client.call<SessionLedgerReadResult>(
      SESSION_LEDGER_RPC,
      host && host !== 'local' ? { host } : {}
    )
    printResult(response, json, formatSessionLedger)
  }
}
