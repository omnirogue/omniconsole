import {
  appliedRevision,
  mayEstablishOwnership,
  type OrganizationChange,
  type OrganizationRecord
} from '../../../shared/session-organization-change'

/** Hears every organization change this window applied, as main records it (the ownership mirror). */
export type OrganizationAppliedListener = (record: OrganizationRecord) => void

let installedListener: OrganizationAppliedListener | null = null

export function setOrganizationAppliedListener(listener: OrganizationAppliedListener | null): void {
  installedListener = listener
}

/** Tells the listener about one applied change; a listener failure never fails the change. */
export function noteOrganizationApplied(
  change: OrganizationChange,
  applied: {
    before?: unknown[]
    after?: unknown[]
    revision?: string
    /** Main did not confirm the record: it may take ownership back, never give it. */
    unconfirmed?: boolean
  },
  listener: OrganizationAppliedListener | null | undefined = installedListener
): void {
  const aligned = (values: unknown[] | undefined) =>
    values && values.length === change.targets.length ? values : undefined
  const before = aligned(applied.before)
  const after = aligned(applied.after)
  const record: OrganizationRecord = {
    ...change,
    phase: 'applied',
    ts: new Date().toISOString(),
    revision: applied.revision ?? appliedRevision(change),
    ...(before ? { before } : {}),
    ...(after ? { after } : {})
  }
  // Why: ownership counts only once main holds the applied record (it reconciles the rest).
  if (applied.unconfirmed && mayEstablishOwnership(record)) {
    return
  }
  try {
    listener?.(record)
  } catch (error) {
    console.warn('[session-organization] the ownership mirror could not take a change', error)
  }
}
