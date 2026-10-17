/**
 * Organization actions on the owner service: D's host commit (`apply`/`undo`) against the revision
 * the caller observed, with the executor derived from the authority. An unattended caller may only
 * archive, and only a session that passes Tier 2 now and that no other session waits on, here or on
 * another computer (an uncertain wait registration counts as a wait).
 */

import type { OrganizationChange } from '../../shared/session-organization-change'
import type {
  HostOrganizationApi,
  HostOrganizationOutcome
} from '../../shared/session-organization-host'
import type { SessionHostAuthority } from '../../shared/session-host-authority'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import type {
  SessionHostExecutionRequest,
  SessionHostPrepared
} from '../session-host/session-host-executor'
import type { SessionHostSettlement } from '../session-host/session-host-settlement'
import { executorForActor } from '../session-organization/organization-relayed-mutation'
import { admitUnattendedOrganization } from '../session-manage/session-manage-unattended-admission'
import { stewardSwitchRefusal } from '../session-manage/session-manage-unattended'
import { SessionManageRefusal } from '../session-manage/session-manage-refusal'
import { refusalOf, type OwnerTarget } from './session-host-owner-target'

export type OrganizationAction = 'rename' | 'archive' | 'unarchive' | 'organize' | 'undo'

export type OwnerOrganizationDeps = {
  /** This profile's headless organization host (package D); null when it is not running. */
  host(): HostOrganizationApi | null
  /** Whether a session on another computer waits on this one; uncertain counts as waiting. */
  remotelyAwaited(conversationId: string): boolean
}

type Change = Omit<OrganizationChange, 'opId' | 'executor'>

function changeOf(
  action: Exclude<OrganizationAction, 'undo'>,
  payload: SessionHostPayloads[Exclude<OrganizationAction, 'undo'>],
  targets: OrganizationChange['targets']
): Change {
  switch (action) {
    case 'rename': {
      const rename = payload as SessionHostPayloads['rename']
      return {
        kind: 'title',
        targets,
        value: rename.title,
        ...(rename.origin ? { origin: rename.origin } : {})
      }
    }
    case 'archive':
      return { kind: 'archive', targets, value: true }
    case 'unarchive':
      return { kind: 'unarchive', targets, value: false }
    case 'organize': {
      const organize = payload as SessionHostPayloads['organize']
      return { kind: organize.kind, targets, value: organize.value }
    }
  }
}

function provenance(
  authority: SessionHostAuthority
): Pick<OrganizationChange, 'reason' | 'request'> {
  if (authority.kind !== 'remote') {
    return {}
  }
  const { reason, request } = authority.origin
  return { ...(reason ? { reason } : {}), ...(request ? { request } : {}) }
}

export function settleOrganization(outcome: HostOrganizationOutcome): SessionHostSettlement {
  if (outcome.status === 'applied') {
    return {
      kind: 'completed',
      result: {
        revision: outcome.revision,
        organizationRevisions: outcome.organizationRevisions,
        mode: outcome.mode,
        ...(outcome.replay ? { replay: true } : {})
      }
    }
  }
  return {
    kind: 'not-delivered',
    refusal:
      outcome.status === 'refused'
        ? outcome.refusal
        : sessionHostRefusal('not-eligible', `${outcome.error} Nothing was changed.`)
  }
}

function staleRevision(
  host: HostOrganizationApi,
  key: string,
  expected: string | undefined
): SessionHostRefusal | null {
  if (expected === undefined) {
    return null
  }
  const current = host.read([key]).sessions[0]?.organizationRevision
  return current !== undefined && current !== expected
    ? sessionHostRefusal(
        'stale-organization-revision',
        'Its organization changed since it was read, so nothing was changed. Read it again.',
        { current: { organizationRevision: current } }
      )
    : null
}

async function unattendedArchive(
  deps: OwnerOrganizationDeps,
  target: OwnerTarget,
  change: Change,
  conversationId: string
): Promise<{ evidence?: string } | SessionHostRefusal> {
  if (!target.unattended) {
    return {}
  }
  const off = change.kind === 'archive' ? stewardSwitchRefusal('tier2Archive') : null
  if (off) {
    return sessionHostRefusal('automation-disabled', off)
  }
  if (change.kind === 'archive' && deps.remotelyAwaited(conversationId)) {
    return sessionHostRefusal(
      'not-eligible',
      'A session on another computer waits on its result, so it is not archived automatically. Nothing was changed.'
    )
  }
  try {
    const evidence = await admitUnattendedOrganization(target.actor, change)
    return evidence ? { evidence } : {}
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return refusalOf(error, 'unattended-restricted')
    }
    throw error
  }
}

export async function prepareHostOrganization(
  deps: OwnerOrganizationDeps,
  target: OwnerTarget,
  request: Extract<SessionHostExecutionRequest, { action: OrganizationAction }>,
  authority: SessionHostAuthority
): Promise<SessionHostPrepared> {
  const host = deps.host()
  if (!host) {
    return {
      kind: 'refuse',
      refusal: sessionHostRefusal(
        'unsupported-capability',
        'That computer cannot commit organization changes now. Nothing was changed.'
      )
    }
  }
  const key = target.session.row.viewKey
  const stale = staleRevision(host, key, request.expectedOrganizationRevision)
  if (stale) {
    return { kind: 'refuse', refusal: stale }
  }
  const executor = executorForActor(target.actor)
  if (request.action === 'undo') {
    if (target.unattended) {
      return {
        kind: 'refuse',
        refusal: sessionHostRefusal(
          'unattended-restricted',
          'Undo needs the person; an automatic caller never undoes a change. Nothing was changed.'
        )
      }
    }
    const { undoOf } = request.payload as SessionHostPayloads['undo']
    return {
      kind: 'dispatch',
      dispatch: async () => {
        const undone = await host.undo(undoOf, {
          executor,
          mintOpId: request.operationId,
          ...(request.expectedOrganizationRevision
            ? { expectedOrganizationRevision: request.expectedOrganizationRevision }
            : {})
        })
        if (undone.outcome) {
          return settleOrganization(undone.outcome)
        }
        return undone.error
          ? { kind: 'not-delivered', refusal: sessionHostRefusal('not-eligible', undone.error) }
          : { kind: 'completed', result: { undone: undone.undone, total: undone.total } }
      }
    }
  }
  const targets = [{ sessionKey: key }]
  const change = changeOf(request.action, request.payload, targets)
  const admitted = await unattendedArchive(deps, target, change, request.conversationId)
  if ('code' in admitted) {
    return { kind: 'refuse', refusal: admitted }
  }
  return {
    kind: 'dispatch',
    dispatch: async () =>
      settleOrganization(
        await host.apply({
          ...change,
          ...provenance(authority),
          ...(admitted.evidence ? { evidence: admitted.evidence } : {}),
          executor,
          opId: request.operationId,
          ...(request.expectedOrganizationRevision
            ? { expectedOrganizationRevision: request.expectedOrganizationRevision }
            : {})
        })
      )
  }
}
