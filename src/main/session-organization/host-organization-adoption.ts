/**
 * A window that opens on a host which committed organization changes while it was closed adopts
 * them before its account sync runs, so it shows what the ledger says and publishes it as this
 * computer's own edit. A change whose field became the person's after it (another computer, an
 * older app) is not handed out; where the window holds another value, the window's value wins.
 */

import {
  isPersonExecutor,
  organizationTargetKey,
  organizationValueAt,
  ownershipFieldOf,
  type OrganizationRecord
} from '../../shared/session-organization-change'
import {
  isHostOrganizationKind,
  readHostOrganizationValue,
  type HostOrganizationAdoption
} from '../../shared/session-organization-host'
import { sameOwnedValue } from '../../shared/session-organization-ownership'
import type { HostOrganizationContext } from './host-organization-context'
import { recordHostRestore, restoreChangeFor } from './host-organization-migration'

function revokedSince(context: HostOrganizationContext, record: OrganizationRecord): boolean {
  const field = ownershipFieldOf(record.kind)
  if (!field || isPersonExecutor(record.executor)) {
    return false
  }
  return record.targets.some((target) => {
    const key = organizationTargetKey(target)
    const revocation = key ? context.ledger.store.stateFor(key).revocations[field] : undefined
    return revocation !== undefined && revocation.at > record.ts
  })
}

/** Headless changes the window has not adopted yet, oldest first. */
export function pendingHostAdoption(context: HostOrganizationContext): OrganizationRecord[] {
  const superseded: string[] = []
  const records = context.view.unadopted().flatMap((opId) => {
    const record = context.ledger.store.get(opId)
    if (!record || revokedSince(context, record)) {
      superseded.push(opId)
      return []
    }
    return [record]
  })
  if (superseded.length > 0) {
    context.view.settleAdopted(superseded)
  }
  return records
}

/** Callers serialize it. Returns the restore records written for conflicts. */
export async function settleHostAdoption(
  context: HostOrganizationContext,
  adoption: HostOrganizationAdoption
): Promise<string[]> {
  const restored: string[] = []
  for (const conflict of adoption.conflicts) {
    const record = context.ledger.store.get(conflict.opId)
    const index = record
      ? record.targets.findIndex((target) => organizationTargetKey(target) === conflict.key)
      : -1
    if (!record || index < 0 || !isHostOrganizationKind(record.kind)) {
      continue
    }
    const value = organizationValueAt(record, index)
    const held = readHostOrganizationValue(
      record.kind,
      context.view.entry(conflict.key),
      value,
      context.now().getTime()
    )
    const change = restoreChangeFor(record.kind, conflict.key, value, conflict.value)
    if (!change || sameOwnedValue(held, conflict.value)) {
      continue
    }
    const opId = await recordHostRestore(context, change, held, conflict.value)
    if (opId) {
      restored.push(opId)
    }
  }
  context.view.settleAdopted([...adoption.adopted, ...adoption.conflicts.map(({ opId }) => opId)])
  return restored
}
