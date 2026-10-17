/**
 * Who a caller is to admission: the reservation holder it becomes, what the audit records, and the
 * fingerprint that makes a repeated operation id either a replay or a conflict. Derived only from
 * the authority the host built from its transport, never from anything a payload says.
 */

import { canonicalJson } from '../../shared/decision-contracts/decision-calibration-summary'
import { sessionHostRequestFingerprint } from '../../shared/session-host-admission'
import {
  isUnattendedSessionHostAuthority,
  type SessionHostAuthority,
  type SessionHostOrigin
} from '../../shared/session-host-authority'
import { sessionHostDigest } from '../../shared/session-host-identity'
import type {
  SessionHostReleaseParams,
  SessionHostRequest
} from '../../shared/session-host-protocol'
import type { SessionHostExecutionRequest } from './session-host-executor'
import type { SessionHostOperationAudit } from './session-host-journal'

export type SessionHostInProcessAuthority = Exclude<SessionHostAuthority, { kind: 'remote' }>
export type SessionHostRemoteAuthority = Extract<SessionHostAuthority, { kind: 'remote' }>

/** The reservation holder an authenticated peer is, whatever origin it names. */
export function sessionHostPeerHolder(peer: string): string {
  return `remote:${peer}`
}

export function sessionHostHolder(authority: SessionHostAuthority): string {
  if (authority.kind === 'remote') {
    return sessionHostPeerHolder(authority.peer)
  }
  const { actor } = localActor(authority)
  return actor.kind === 'steward'
    ? `steward:${actor.feature}`
    : actor.kind === 'pane'
      ? `local:pane:${actor.paneKey}`
      : 'local:cli'
}

type LocalActor =
  | { kind: 'steward'; feature: string; runId?: string }
  | { kind: 'pane'; paneKey: string; unattended?: { source: string } }
  | { kind: 'cli'; unattended?: { source: string } }

/** One shape for this host's own callers: its steward, or its UI/CLI (possibly unattended). */
function localActor(authority: SessionHostInProcessAuthority): { actor: LocalActor } {
  return authority.kind === 'steward'
    ? {
        actor: {
          kind: 'steward',
          feature: authority.feature,
          ...(authority.runId ? { runId: authority.runId } : {})
        }
      }
    : { actor: authority.actor }
}

function requesterLabel(origin: SessionHostOrigin): string {
  const { requester } = origin
  const unattended = requester.kind !== 'person' && requester.unattended ? ' (unattended)' : ''
  return requester.kind === 'person'
    ? `person via ${requester.via}`
    : requester.kind === 'pane'
      ? `pane ${requester.paneKey}${unattended}`
      : `cli${unattended}`
}

export function sessionHostAudit(authority: SessionHostAuthority): SessionHostOperationAudit {
  if (authority.kind === 'remote') {
    return {
      authority: 'remote',
      peer: authority.peer,
      computer: authority.origin.computer,
      requester: requesterLabel(authority.origin),
      ...(authority.origin.request ? { request: authority.origin.request } : {}),
      ...(authority.origin.reason ? { reason: authority.origin.reason } : {})
    }
  }
  const { actor } = localActor(authority)
  if (actor.kind === 'steward') {
    return {
      authority: 'steward',
      requester: `${actor.feature}${actor.runId ? ` ${actor.runId}` : ''}`
    }
  }
  const unattended = actor.unattended ? ` (unattended: ${actor.unattended.source})` : ''
  return {
    authority: 'local',
    requester: `${actor.kind === 'pane' ? `pane ${actor.paneKey}` : 'cli'}${unattended}`
  }
}

/**
 * The reference decision reads unattendedness from `origin`. An in-process caller has no origin,
 * so it gets one that carries exactly that and nothing else; it is never stored or sent.
 */
function decisionOrigin(authority: SessionHostInProcessAuthority): SessionHostOrigin {
  if (!isUnattendedSessionHostAuthority(authority)) {
    return { computer: 'this computer', requester: { kind: 'person', via: 'this-computer' } }
  }
  const { actor } = localActor(authority)
  const source = actor.kind === 'steward' ? actor.feature : (actor.unattended?.source ?? 'rules')
  return {
    computer: 'this computer',
    requester: {
      kind: 'cli',
      unattended: { source: source === 'cleanup-run' ? 'cleanup-run' : 'rules' }
    }
  }
}

export function sessionHostDecisionRequest(
  request: SessionHostExecutionRequest,
  authority: SessionHostAuthority
): SessionHostRequest {
  const origin = authority.kind === 'remote' ? authority.origin : decisionOrigin(authority)
  return { ...request, origin } as SessionHostRequest
}

export function sessionHostFingerprint(
  request: SessionHostExecutionRequest,
  authority: SessionHostAuthority
): string {
  if (authority.kind === 'remote') {
    return sessionHostRequestFingerprint({
      ...request,
      origin: authority.origin
    } as SessionHostRequest)
  }
  return sessionHostDigest(
    canonicalJson([
      'session-host-request/in-process/v1',
      request.conversationId,
      request.expectedOwnerEpoch,
      request.expectedTurnRevision,
      request.expectedOrganizationRevision ?? null,
      request.reservation ?? null,
      authority,
      request.action,
      request.payload
    ])
  )
}

export function sessionHostReleaseFingerprint(
  params: Omit<SessionHostReleaseParams, 'origin'>,
  authority: SessionHostAuthority
): string {
  return sessionHostDigest(
    canonicalJson([
      'session-host-release/v1',
      params.conversationId,
      params.reservation,
      authority.kind === 'remote' ? authority.origin : authority
    ])
  )
}
