import { randomUUID } from 'node:crypto'
import {
  inverseOrganizationKind,
  type OrganizationChange,
  type OrganizationRelayedOutcome
} from '../../shared/session-organization-change'
import type { OrganizationChangeLedger } from './organization-change-ledger'
import type { OrganizationRelay } from './organization-relayed-mutation'

/** The inverse of a change the window applied, relayed and recorded as an Undo of it. */
export async function relayPutBack(
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>,
  relay: OrganizationRelay,
  applied: OrganizationChange,
  outcome: OrganizationRelayedOutcome,
  reason: string,
  /** The revision the archive settled at: a person's later change to the row refuses the inverse. */
  expectedRevision: string | undefined,
  /** The error recorded when an older window answers the inverse with nothing. */
  windowTooOld: string
): Promise<{ restored: true } | { restored: false; error: string }> {
  const kind = inverseOrganizationKind(applied.kind)
  if (!kind) {
    return { restored: false, error: `a ${applied.kind} has no inverse` }
  }
  const change: OrganizationChange = {
    opId: randomUUID(),
    kind,
    targets: outcome.targets,
    value: outcome.before?.[0] ?? null,
    ...(outcome.before && outcome.before.length > 1 ? { values: outcome.before } : {}),
    executor: applied.executor,
    reason: `put back: ${reason}`,
    undoOf: applied.opId,
    ...(expectedRevision ? { expectedRevision } : {})
  }
  await ledger.prepare(change)
  let result: OrganizationRelayedOutcome | undefined
  try {
    result = (await relay({ kind: 'applyOrganizationChange', change })) as
      | OrganizationRelayedOutcome
      | undefined
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    await ledger.settle({ phase: 'failed', change, error: text, audit: { summary: text } })
    return { restored: false, error: text }
  }
  if (result?.opId !== change.opId) {
    await ledger.settle({ phase: 'failed', change, error: windowTooOld })
    return { restored: false, error: windowTooOld }
  }
  await ledger.settle({
    phase: 'applied',
    change: { ...change, targets: result.targets, value: result.value },
    ...(result.before ? { before: result.before } : {}),
    ...(result.after ? { after: result.after } : {})
  })
  return { restored: true }
}
