/**
 * The Work card's lines for the other computers that run sessions here: one per computer, never
 * one per session, so a hundred sessions elsewhere stay a few lines. A computer that cannot be
 * reached says so (its sessions are left alone); one that cannot take controls says why.
 */

import { translate } from '@/i18n/i18n'
import { SESSION_CONTROL_DELIVERY_CAPABILITY } from '../../../../shared/session-host-capability-names'
import type {
  HostSwitchReading,
  RemoteHostSnapshot,
  SessionHostsStatusResult
} from '../../../../shared/session-hosts-status'

export type OtherComputerLine = {
  hostKey: string
  label: string
  state: RemoteHostSnapshot['state']
  summary: string
  detail?: string
  /** Automatic actions switched off on that computer, and whether it confirmed. */
  automationOff?: HostSwitchReading['state']
}

function countsSummary(host: RemoteHostSnapshot): string {
  const counts = host.counts
  if (!counts || counts.total === 0) {
    return translate('work.otherComputers.noSessions', 'No sessions it carries out controls for')
  }
  const parts = [
    translate('work.otherComputers.sessions', '{{count}} sessions', { count: counts.total }),
    counts.working
      ? translate('work.otherComputers.working', '{{count}} working', { count: counts.working })
      : null,
    counts.needsYou
      ? translate('work.otherComputers.needsYou', '{{count}} need you', { count: counts.needsYou })
      : null,
    counts.stalled
      ? translate('work.otherComputers.stalled', '{{count}} stalled', { count: counts.stalled })
      : null,
    counts.unverifiable
      ? translate('work.otherComputers.unverifiable', '{{count}} can’t be verified', {
          count: counts.unverifiable
        })
      : null
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

function stateSummary(host: RemoteHostSnapshot): string {
  switch (host.state) {
    case 'ready':
      return host.capabilities.includes(SESSION_CONTROL_DELIVERY_CAPABILITY)
        ? `${countsSummary(host)} · ${translate('work.otherComputers.delivery', 'takes this Mac’s automatic prompts')}`
        : countsSummary(host)
    case 'checking':
      return translate('work.otherComputers.checking', 'Checking…')
    case 'unreachable':
      return translate(
        'work.otherComputers.unreachable',
        'Can’t be reached; its sessions are left alone'
      )
    case 'older':
      return translate(
        'work.otherComputers.older',
        'Older OmniConsole; controls are unavailable until it updates'
      )
    case 'controls-off':
      return translate(
        'work.otherComputers.controlsOff',
        'Offers no session controls (switched off there)'
      )
  }
}

export function otherComputerLines(
  status: SessionHostsStatusResult,
  labels: ReadonlyMap<string, string>
): OtherComputerLine[] {
  const switches = new Map(status.switches.map((reading) => [reading.hostId, reading]))
  return status.hosts.map((host) => {
    const reading = host.hostId ? switches.get(host.hostId) : undefined
    return {
      hostKey: host.hostKey,
      label: labels.get(host.hostKey) ?? host.hostKey,
      state: host.state,
      summary: stateSummary(host),
      ...(host.detail && host.state !== 'ready' ? { detail: host.detail } : {}),
      ...(reading?.automation === 'off' ? { automationOff: reading.state } : {})
    }
  })
}
