/**
 * The window's half of headless organization (docs/reference/session-host-control.md): changes
 * this computer's host committed while no window was open are applied to the sidebar's stores
 * before account sync runs, so the window shows what the ledger says and publishes it as this
 * computer's edit. They are recorded already, so they are applied here without a new record.
 * Where the window holds a value the change did not start from, the window's value wins.
 */

import {
  organizationValueAt,
  type OrganizationChange,
  type OrganizationRecord,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  isHostOrganizationKind,
  type HostOrganizationAdoption
} from '../../../shared/session-organization-host'
import {
  applyOrganizationValues,
  readOrganizationValue,
  type OrganizationStores
} from './session-organization-values'

export type HostAdoptionResult = HostOrganizationAdoption & {
  /** Targets the window cannot read yet (a tab not restored): the change stays pending. */
  waiting: string[]
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

type TargetOutcome =
  | { status: 'adopted' }
  | { status: 'waiting' }
  | { status: 'conflict'; value: unknown }

function adoptTarget(
  record: OrganizationRecord,
  index: number,
  target: OrganizationTarget,
  stores: OrganizationStores
): TargetOutcome {
  const value = organizationValueAt(record, index)
  const now = readOrganizationValue(record.kind, target, stores, value)
  if (!now.known) {
    return { status: 'waiting' }
  }
  const after = record.after?.[index]
  if (same(now.value, after)) {
    return { status: 'adopted' }
  }
  if (!record.before || !same(now.value, record.before[index])) {
    return { status: 'conflict', value: now.value }
  }
  const change: OrganizationChange = {
    opId: record.opId,
    kind: record.kind,
    targets: [target],
    value,
    executor: record.executor,
    ...(record.origin ? { origin: record.origin } : {}),
    ...(record.undoOf ? { undoOf: record.undoOf } : {})
  }
  const applied = applyOrganizationValues(change, stores)
  const held = 'after' in applied ? applied.after[0] : now.value
  return same(held, after) ? { status: 'adopted' } : { status: 'conflict', value: held }
}

/**
 * Oldest first, each target applied only while the window still holds what the change started
 * from. `tabOf` names the tab a session's title lives on (null when none is open).
 */
export function adoptHostOrganizationChanges(
  records: readonly OrganizationRecord[],
  stores: OrganizationStores,
  tabOf: (sessionKey: string) => string | null
): HostAdoptionResult {
  const result: HostAdoptionResult = { adopted: [], conflicts: [], waiting: [] }
  for (const record of records) {
    if (!isHostOrganizationKind(record.kind)) {
      result.adopted.push(record.opId)
      continue
    }
    const outcomes = record.targets.map((target, index) => {
      const key = target.sessionKey
      const tabId = key && record.kind === 'title' ? tabOf(key) : null
      if (!key || (record.kind === 'title' && !tabId)) {
        return { key, outcome: { status: 'waiting' } as TargetOutcome }
      }
      const local: OrganizationTarget = { sessionKey: key, ...(tabId ? { tabId } : {}) }
      return { key, outcome: adoptTarget(record, index, local, stores) }
    })
    if (outcomes.every(({ outcome }) => outcome.status === 'waiting')) {
      result.waiting.push(record.opId)
      continue
    }
    const conflicts = outcomes.flatMap(({ key, outcome }) =>
      key && outcome.status === 'conflict' ? [{ opId: record.opId, key, value: outcome.value }] : []
    )
    if (conflicts.length > 0) {
      result.conflicts.push(...conflicts)
    } else {
      result.adopted.push(record.opId)
    }
  }
  return result
}
