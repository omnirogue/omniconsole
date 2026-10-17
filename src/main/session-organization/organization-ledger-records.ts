// The ledger's record shaping: a record's change, per-target arrays, target identity, and the
// audit fields a replayed trail line carried.

import type {
  OrganizationChange,
  OrganizationRecord,
  OrganizationTarget
} from '../../shared/session-organization-change'
import type { OrganizationAudit, OrganizationTrailEntry } from './organization-trail'

/** The change a record carries, without its phase fields. */
export function changeOf(record: OrganizationRecord): OrganizationChange {
  const {
    phase: _phase,
    ts: _ts,
    before: _before,
    after: _after,
    revision: _revision,
    error: _error,
    reconciled: _reconciled,
    revisionUnchecked: _unchecked,
    headless: _headless,
    ...change
  } = record
  return change
}

/** A per-target array only when it lines up with the targets. */
export function aligned(
  name: 'before' | 'after',
  values: unknown[] | undefined,
  targets: readonly OrganizationTarget[]
): Partial<Record<'before' | 'after', unknown[]>> {
  return values && values.length === targets.length ? { [name]: values } : {}
}

export function sameTarget(left: OrganizationTarget, right: OrganizationTarget): boolean {
  return Boolean(
    (left.sessionKey && left.sessionKey === right.sessionKey) ||
    (left.paneKey && left.paneKey === right.paneKey) ||
    (left.tabId && left.tabId === right.tabId) ||
    (left.folderId && left.folderId === right.folderId)
  )
}

/** The audit fields a trail line carried, for the line that settles it. */
export function auditOfLine(line: OrganizationTrailEntry['line']): OrganizationAudit {
  const { actor, unverifiedPaneKey, steward, unattended } = line
  return {
    // Why undefined fields are fine: the rewritten JSON line drops them, as the original did.
    actor: { actor, unverifiedPaneKey, steward, unattended },
    target: line.target,
    summary: line.summary
  }
}
