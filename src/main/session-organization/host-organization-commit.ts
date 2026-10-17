/**
 * One organization change committed by the execution host: the same checks the window's path
 * makes (reason, ownership revision, value drift), plus the host's own (migration done, nothing
 * interrupted, `expectedOrganizationRevision`). With a window it goes through the window as
 * before; without one, the applied record the ledger writes is the change.
 */

import { SESSION_FOLDERS_NO_WINDOW_ERROR } from '../../shared/session-folder-cli'
import type { SessionHostRefusalCode } from '../../shared/session-host-refusal'
import {
  isPersonExecutor,
  organizationTargetKey,
  organizationValueAt,
  ownershipFieldOf,
  type OrganizationChange,
  type OrganizationRecord,
  type OrganizationRelayedOutcome
} from '../../shared/session-organization-change'
import {
  hostOrganizationAfter,
  hostOrganizationRevision,
  isHostOrganizationKind,
  readHostOrganizationValue,
  type HostOrganizationKind,
  type HostOrganizationMode,
  type HostOrganizationOutcome,
  type HostOrganizationRequest
} from '../../shared/session-organization-host'
import { sameOwnedValue } from '../../shared/session-organization-ownership'
import {
  organizationChangeReasonRefusal,
  relayOrganizationChange
} from './organization-relayed-mutation'
import { staleRevisionRefusal } from './organization-revision-check'
import { hostRefusal, messageOf, type HostOrganizationContext } from './host-organization-context'

export const HOST_ORGANIZATION_NOT_MIGRATED =
  'This host has not imported the existing session organization and who set it yet, so no automatic change is made here. Nothing changed.'

type Extra = { replay?: true; auditError?: string }

function sameChange(recorded: OrganizationRecord, change: OrganizationChange): boolean {
  const body = (entry: OrganizationChange) =>
    JSON.stringify([
      entry.kind,
      entry.targets,
      entry.value ?? null,
      entry.values ?? null,
      entry.executor
    ])
  return body(recorded) === body(change)
}

function appliedOutcome(
  context: HostOrganizationContext,
  record: OrganizationRecord,
  extra: Extra
): HostOrganizationOutcome {
  const mode: HostOrganizationMode = record.headless ? 'headless' : 'window'
  return {
    status: 'applied',
    opId: record.opId,
    mode,
    before: record.before ?? [],
    after: record.after ?? [],
    revision: record.revision ?? record.opId,
    organizationRevisions: record.targets.map((target) => {
      const key = organizationTargetKey(target)
      return hostOrganizationRevision(key ? context.view.entry(key) : undefined)
    }),
    ...extra
  }
}

/** The window's drift check too: an owned field must still hold the value its owner left. */
function ownedDrift(
  context: HostOrganizationContext,
  change: OrganizationChange,
  kind: HostOrganizationKind
): string | null {
  const field = ownershipFieldOf(kind)
  if (!change.expectedRevision || !field || isPersonExecutor(change.executor)) {
    return null
  }
  const nowMs = context.now().getTime()
  for (const target of change.targets) {
    const key = target.sessionKey!
    const owned = context.ledger.store.stateFor(key).ownership[field]
    const held = readHostOrganizationValue(kind, context.view.entry(key), undefined, nowMs)
    if (owned && !sameOwnedValue(held, owned.value)) {
      const name = field === 'placement' ? 'folder' : 'title'
      return `This session's ${name} was changed by something that recorded no change since revision ${change.expectedRevision}. Nothing changed.`
    }
  }
  return null
}

/** Why the change cannot be committed as asked, or null. */
function refusalOf(
  context: HostOrganizationContext,
  change: OrganizationChange,
  expectedOrganizationRevision: string | undefined
): { code: SessionHostRefusalCode; message: string; current?: string } | null {
  const { kind } = change
  if (!isHostOrganizationKind(kind)) {
    return {
      code: 'invalid-request',
      message: `A host does not commit a ${kind} itself. Nothing changed.`
    }
  }
  if (change.targets.length === 0 || change.targets.some((target) => !target.sessionKey)) {
    return {
      code: 'invalid-request',
      message: 'Every target of a host change names its session key. Nothing changed.'
    }
  }
  for (let index = 0; index < change.targets.length; index += 1) {
    const after = hostOrganizationAfter(kind, organizationValueAt(change, index))
    if (!after.ok) {
      return { code: 'invalid-request', message: after.error }
    }
  }
  const reason = organizationChangeReasonRefusal(change, false)
  if (reason) {
    return { code: 'invalid-request', message: reason }
  }
  if (!isPersonExecutor(change.executor) && context.view.migratedAt === null) {
    return { code: 'not-adopted', message: HOST_ORGANIZATION_NOT_MIGRATED }
  }
  const keys = new Set(change.targets.map((target) => target.sessionKey!))
  const interrupted = context.ledger
    .pending()
    .some((record) => record.targets.some((target) => keys.has(target.sessionKey ?? '')))
  if (interrupted) {
    return {
      code: 'reconciling',
      message:
        'An earlier change to this session was interrupted and is not reconciled yet. Nothing changed.'
    }
  }
  for (const key of expectedOrganizationRevision === undefined ? [] : keys) {
    const current = hostOrganizationRevision(context.view.entry(key))
    if (current !== expectedOrganizationRevision) {
      return {
        code: 'stale-organization-revision',
        message: `This session's organization changed since revision ${expectedOrganizationRevision} (it is at ${current}). Nothing changed.`,
        current
      }
    }
  }
  const stale = staleRevisionRefusal(change, context.ledger.store)
  if (stale) {
    return {
      code: ownershipFieldOf(kind) ? 'ownership-conflict' : 'stale-organization-revision',
      message: stale
    }
  }
  const drifted = ownedDrift(context, change, kind)
  return drifted ? { code: 'ownership-conflict', message: drifted } : null
}

async function commitHeadless(
  context: HostOrganizationContext,
  change: OrganizationChange,
  kind: HostOrganizationKind
): Promise<HostOrganizationOutcome> {
  const { ledger, view } = context
  const person = isPersonExecutor(change.executor)
  const nowMs = context.now().getTime()
  const before = change.targets.map((target, index) =>
    readHostOrganizationValue(
      kind,
      view.entry(target.sessionKey!),
      organizationValueAt(change, index),
      nowMs
    )
  )
  const after = change.targets.map((_target, index) => {
    const next = hostOrganizationAfter(kind, organizationValueAt(change, index))
    return next.ok ? next.after : null
  })
  try {
    // Why prepared first even here: no record, no change, like every non-person change.
    if (!person) {
      await ledger.prepare(change, { before, headless: true })
    }
    const settled = await ledger.settle({
      phase: 'applied',
      change,
      before,
      after,
      ...(person ? { headless: true as const } : {})
    })
    return appliedOutcome(
      context,
      settled.record,
      settled.auditError ? { auditError: settled.auditError } : {}
    )
  } catch (error) {
    return {
      status: 'refused',
      opId: change.opId,
      refusal: hostRefusal('storage-unavailable', messageOf(error))
    }
  }
}

/** Null when no window answered: the caller commits headlessly under the same operation id. */
async function commitThroughWindow(
  context: HostOrganizationContext,
  change: OrganizationChange
): Promise<HostOrganizationOutcome | null> {
  const { ledger } = context
  const relay = context.relay!
  try {
    if (!isPersonExecutor(change.executor)) {
      const relayed = await relayOrganizationChange(ledger, relay, change)
      const record = ledger.store.get(change.opId)
      return record
        ? appliedOutcome(
            context,
            record,
            relayed.auditError ? { auditError: relayed.auditError } : {}
          )
        : {
            status: 'failed',
            opId: change.opId,
            error: 'The window applied it, but it was not recorded.'
          }
    }
    // A person's change applies first and is recorded after, as in the window.
    const outcome = (await relay({ kind: 'applyOrganizationChange', change })) as
      | OrganizationRelayedOutcome
      | undefined
    if (outcome?.opId !== change.opId) {
      return { status: 'failed', opId: change.opId, error: 'The window did not apply the change.' }
    }
    const settled = await ledger.settle({
      phase: 'applied',
      change: { ...change, targets: outcome.targets, value: outcome.value },
      ...(outcome.before ? { before: outcome.before } : {}),
      ...(outcome.after ? { after: outcome.after } : {})
    })
    return appliedOutcome(
      context,
      settled.record,
      settled.auditError ? { auditError: settled.auditError } : {}
    )
  } catch (error) {
    const message = messageOf(error)
    return message === SESSION_FOLDERS_NO_WINDOW_ERROR
      ? null
      : { status: 'failed', opId: change.opId, error: message }
  }
}

/** Callers serialize: a revision checked here still holds when the change is recorded. */
export async function commitHostOrganizationChange(
  context: HostOrganizationContext,
  request: HostOrganizationRequest
): Promise<HostOrganizationOutcome> {
  const { expectedOrganizationRevision, opId: requested, ...rest } = request
  const change: OrganizationChange = { ...rest, opId: requested ?? context.mintOpId() }
  const recorded = context.ledger.store.get(change.opId)
  if (recorded) {
    return sameChange(recorded, change)
      ? appliedOutcome(context, recorded, { replay: true })
      : {
          status: 'refused',
          opId: change.opId,
          refusal: hostRefusal(
            'operation-conflict',
            `Operation ${change.opId} was already used for another change. Nothing changed.`
          )
        }
  }
  const refused = refusalOf(context, change, expectedOrganizationRevision)
  if (refused) {
    return {
      status: 'refused',
      opId: change.opId,
      refusal: hostRefusal(refused.code, refused.message, refused.current)
    }
  }
  const kind = change.kind as HostOrganizationKind
  if (context.relay && context.windowAttached?.() !== false) {
    const through = await commitThroughWindow(context, change)
    if (through) {
      return through
    }
  }
  return commitHeadless(context, change, kind)
}
