/**
 * Negotiates Phase 4 capabilities, per capability, between a client and an execution host, and
 * turns anything not mutually supported into an explicit refusal. There is no fallback: an
 * unsupported peer never gets local execution or raw terminal input instead.
 */

import {
  SESSION_HOST_CAPABILITIES,
  SESSION_HOST_CAPABILITY_PREREQUISITES,
  isSessionHostCapability,
  type SessionHostAdvertisement,
  type SessionHostCapability,
  type SessionHostRelocationProvider
} from './session-host-capabilities'
import type { SessionHostIdentity } from './session-host-identity'
import {
  SESSION_HOST_METHOD_CAPABILITY,
  sessionHostActionCapability,
  type SessionHostAction,
  type SessionHostMethod
} from './session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from './session-host-refusal'

/** `client`: a Mac reading a host's advertisement. `host`: a host reading a client's declaration. */
export type SessionHostNegotiationSide = 'client' | 'host'
export type SessionHostCapabilityGap = 'local-lacks' | 'peer-lacks' | 'prerequisite'

export type SessionHostNegotiation = {
  side: SessionHostNegotiationSide
  peerStatus: SessionHostAdvertisement['status']
  /** The advertising host (client side); null on the host side or when nothing was advertised. */
  peer: SessionHostIdentity | null
  /** The transport connection it was negotiated on; a reconnect needs a new negotiation. */
  connection: string | null
  agreed: readonly SessionHostCapability[]
  gaps: readonly { capability: SessionHostCapability; gap: SessionHostCapabilityGap }[]
  /** Family names the peer speaks that this build does not know (a newer version). */
  unknownPeerCapabilities: readonly string[]
  detail?: string
}

export function negotiateSessionHostCapabilities(input: {
  side: SessionHostNegotiationSide
  local: readonly string[]
  peer: SessionHostAdvertisement
  connection?: string
}): SessionHostNegotiation {
  const local = new Set(input.local.filter(isSessionHostCapability))
  const peerNames = input.peer.status === 'advertised' ? input.peer.capabilities : []
  const peer = new Set(peerNames.filter(isSessionHostCapability))
  let agreed = SESSION_HOST_CAPABILITIES.filter((cap) => local.has(cap) && peer.has(cap))
  // Why a fixpoint: dropping one capability can strand another that depended on it.
  for (let changed = true; changed;) {
    const kept = agreed.filter((cap) =>
      SESSION_HOST_CAPABILITY_PREREQUISITES[cap].every((needed) => agreed.includes(needed))
    )
    changed = kept.length !== agreed.length
    agreed = kept
  }
  const gaps = SESSION_HOST_CAPABILITIES.filter((cap) => !agreed.includes(cap)).map(
    (capability) => ({
      capability,
      gap: !local.has(capability)
        ? ('local-lacks' as const)
        : !peer.has(capability)
          ? ('peer-lacks' as const)
          : ('prerequisite' as const)
    })
  )
  return {
    side: input.side,
    peerStatus: input.peer.status,
    peer: input.peer.status === 'advertised' ? input.peer.identity : null,
    connection: input.connection ?? null,
    agreed,
    gaps,
    unknownPeerCapabilities: peerNames.filter((name) => !isSessionHostCapability(name)),
    ...(input.peer.status === 'malformed' ? { detail: input.peer.detail } : {})
  }
}

export type SessionHostNegotiationBinding = {
  peer: SessionHostIdentity | null
  connection: string | null
}

/** Stale after a reconnect, or when the host's registry identity or process start changed. */
export function isSessionHostNegotiationCurrent(
  negotiation: SessionHostNegotiation,
  current: SessionHostNegotiationBinding
): boolean {
  const samePeer =
    negotiation.peer === null
      ? current.peer === null || negotiation.side === 'host'
      : current.peer !== null &&
        current.peer.hostId === negotiation.peer.hostId &&
        current.peer.incarnation === negotiation.peer.incarnation
  return samePeer && negotiation.connection === current.connection
}

function familyHint(negotiation: SessionHostNegotiation, capability: string): string {
  const family = capability.replace(/\.v\d+$/, '.v')
  const newer = negotiation.unknownPeerCapabilities.find((name) => name.startsWith(family))
  return newer ? ` It speaks ${newer}, a newer version; update this computer too.` : ''
}

function unsupported(negotiation: SessionHostNegotiation, capability: SessionHostCapability) {
  const gap = negotiation.gaps.find((entry) => entry.capability === capability)?.gap
  const peerName =
    negotiation.side === 'client' ? "That computer's OmniConsole" : 'The requesting OmniConsole'
  const nothing =
    negotiation.side === 'client'
      ? 'Nothing was sent, and nothing runs on this computer instead.'
      : 'Nothing was changed; the session stays visible to it.'
  if (negotiation.peerStatus === 'absent') {
    return `${peerName} predates session host control, so it cannot use ${capability}. Update it. ${nothing}`
  }
  if (negotiation.peerStatus === 'malformed') {
    return `${peerName} described its session host support unreadably (${negotiation.detail ?? 'unknown'}), so ${capability} is refused. ${nothing}`
  }
  if (gap === 'local-lacks') {
    return `This OmniConsole does not support ${capability}. Update it. ${nothing}`
  }
  if (gap === 'prerequisite') {
    const needed = SESSION_HOST_CAPABILITY_PREREQUISITES[capability].join(', ')
    return `${capability} needs ${needed}, which this connection did not negotiate. ${nothing}`
  }
  return `${peerName} does not support ${capability}.${familyHint(negotiation, capability)} ${nothing}`
}

/** Null when the capability may be used on this connection now; otherwise why not, in words. */
export function requireSessionHostCapability(
  negotiation: SessionHostNegotiation,
  capability: string,
  current?: SessionHostNegotiationBinding
): SessionHostRefusal | null {
  if (!isSessionHostCapability(capability)) {
    return sessionHostRefusal(
      'unknown-capability',
      `${capability} is not a session host capability this OmniConsole knows. Nothing was sent.`,
      { capability }
    )
  }
  if (current && !isSessionHostNegotiationCurrent(negotiation, current)) {
    return sessionHostRefusal(
      'renegotiate',
      'The connection or host process changed since its capabilities were read; they are read again before anything is sent.',
      { capability }
    )
  }
  return negotiation.agreed.includes(capability)
    ? null
    : sessionHostRefusal('unsupported-capability', unsupported(negotiation, capability), {
        capability
      })
}

export function requireSessionHostMethod(
  negotiation: SessionHostNegotiation,
  method: SessionHostMethod,
  current?: SessionHostNegotiationBinding
): SessionHostRefusal | null {
  return requireSessionHostCapability(negotiation, SESSION_HOST_METHOD_CAPABILITY[method], current)
}

/** `sessionHost.execute` needs owner control plus the action's own capability. */
export function requireSessionHostAction(
  negotiation: SessionHostNegotiation,
  action: SessionHostAction,
  provider?: SessionHostRelocationProvider,
  current?: SessionHostNegotiationBinding
): SessionHostRefusal | null {
  const capability = sessionHostActionCapability(action, provider)
  if (!capability) {
    return sessionHostRefusal(
      'unknown-capability',
      `${action} needs a provider this OmniConsole can relocate (claude or codex). Nothing was sent.`
    )
  }
  return (
    requireSessionHostMethod(negotiation, 'sessionHost.execute', current) ??
    requireSessionHostCapability(negotiation, capability, current)
  )
}
