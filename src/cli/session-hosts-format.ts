import { SESSION_CONTROL_DELIVERY_CAPABILITY } from '../shared/session-host-capability-names'
import {
  CROSS_COMPUTER_RELOCATION_UNAVAILABLE,
  relocatableProviders,
  type RemoteHostSnapshot,
  type SessionHostsStatusResult
} from '../shared/session-hosts-status'
import { formatOwnerLedgerState } from './session-parity-format'

const STATE_WORDS: Record<RemoteHostSnapshot['state'], string> = {
  checking: 'not read yet',
  unreachable: 'unreachable: its sessions are left alone',
  older: 'older OmniConsole: no session controls',
  'controls-off': 'offers no session controls',
  ready: 'carries out session controls'
}

function countsLine(host: RemoteHostSnapshot): string | null {
  const counts = host.counts
  if (!counts) {
    return null
  }
  const parts = [
    `${counts.total} sessions`,
    counts.working ? `${counts.working} working` : null,
    counts.needsYou ? `${counts.needsYou} need you` : null,
    counts.stalled ? `${counts.stalled} stalled` : null,
    counts.exited ? `${counts.exited} exited` : null,
    counts.unverifiable ? `${counts.unverifiable} unverifiable` : null
  ]
  return parts.filter((part): part is string => part !== null).join(', ')
}

function switchLine(result: SessionHostsStatusResult, host: RemoteHostSnapshot): string | null {
  const reading = result.switches.find((entry) => entry.hostId === host.hostId)
  if (!reading || reading.automation === 'on') {
    return null
  }
  return reading.state === 'applied'
    ? 'automatic actions off (confirmed)'
    : 'automatic actions off (pending: it has not confirmed)'
}

/** Only a computer this Mac can read gets a word on moving; an unread one is not guessed at. */
function relocationLine(host: RemoteHostSnapshot): string | null {
  if (host.state !== 'ready') {
    return null
  }
  const providers = relocatableProviders(host.capabilities)
  if (providers.length === 0) {
    return CROSS_COMPUTER_RELOCATION_UNAVAILABLE
  }
  // Why by kind: an SSH host moves its conversations to a Mac but cannot take one in yet.
  return host.kind === 'ssh'
    ? `moves its conversations to a Mac (${providers.join(', ')}; omni session relocate)`
    : `takes moved conversations (${providers.join(', ')}; omni session relocate)`
}

export function formatSessionHosts(result: SessionHostsStatusResult): string {
  const lines = result.hosts.map((host) =>
    [
      `${host.hostKey} (${host.kind}): ${STATE_WORDS[host.state]}`,
      countsLine(host),
      // Session parity (G2): what this Mac knows of that owner's conversation ledger.
      host.ledger ? formatOwnerLedgerState(host.ledger) : null,
      host.capabilities.includes(SESSION_CONTROL_DELIVERY_CAPABILITY)
        ? "takes this Mac's automatic prompts"
        : null,
      relocationLine(host),
      switchLine(result, host),
      host.detail ?? null
    ]
      .filter((part): part is string => part !== null)
      .join(' · ')
  )
  if (lines.length === 0) {
    lines.push('No session in the sidebar runs on another computer.')
  }
  if (result.thisHostOffElsewhere) {
    lines.push('Another Mac switched automatic actions off on this computer.')
  }
  if (result.refreshing) {
    lines.push('Reading them now; run again for fresh counts.')
  }
  return lines.join('\n')
}
