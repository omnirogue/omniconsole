/**
 * The session-manage actor an execution host acts as for one caller. Every control the owner
 * service carries out runs through session-manage's own functions with this actor, so its marker,
 * hard stops, unattended policy and audit are exactly the ones a local caller gets.
 */

import {
  sessionHostActorTitle,
  type SessionHostAuthority
} from '../../shared/session-host-authority'
import type { SessionManageActor } from '../../shared/session-manage-types'

export function sessionHostActor(authority: SessionHostAuthority): SessionManageActor {
  if (authority.kind === 'local') {
    return authority.actor
  }
  if (authority.kind === 'steward') {
    return {
      kind: 'steward',
      feature: authority.feature,
      ...(authority.runId ? { runId: authority.runId } : {})
    }
  }
  const { requester } = authority.origin
  const unattended = requester.kind !== 'person' ? requester.unattended : undefined
  return {
    kind: 'remote',
    title: sessionHostActorTitle(authority),
    computer: authority.origin.computer,
    peer: authority.peer,
    requester: requester.kind,
    ...(unattended ? { unattended } : {})
  }
}
