import {
  inverseOrganizationKind,
  isOrganizationToggleKind,
  organizationValueAt,
  organizationTargetKey,
  revisionFieldOf,
  type OrganizationChange,
  type OrganizationChangeKind,
  type OrganizationRecord,
  type OrganizationTarget,
  type OrganizationUndoPlan,
  type OrganizationUndoTarget
} from './session-organization-change'

/** The newest applied change to one field of a key (the key's current revision there). */
export type OrganizationLatestLookup = (
  key: string,
  field: string
) => OrganizationRecord | undefined

/**
 * The inverse of one applied change, per target: put back only what nothing changed since (its
 * current revision is still this change's), and report the rest as skipped, never overwritten.
 */
export function planOrganizationUndo(
  record: OrganizationRecord,
  latest: OrganizationLatestLookup
): OrganizationUndoPlan {
  const kind = inverseOrganizationKind(record.kind)
  const field = revisionFieldOf(record.kind)
  const undo: { target: OrganizationTarget; value: unknown }[] = []
  const targets = record.targets.map((target, index): OrganizationUndoTarget => {
    if (!kind || !field) {
      return {
        target,
        status: 'not-undoable',
        detail: `A ${record.kind} is undone from its own toast.`
      }
    }
    if (!record.before || index >= record.before.length) {
      return { target, status: 'not-undoable', detail: 'Where it was before was not recorded.' }
    }
    const toggle = isOrganizationToggleKind(record.kind)
    // Why: untagging a session that already had the tag would take away something it had before.
    if (toggle && JSON.stringify(record.before[index]) === JSON.stringify(record.after?.[index])) {
      return { target, status: 'not-undoable', detail: 'This change did not change it.' }
    }
    const key = organizationTargetKey(target)
    const current = key ? latest(key, field) : undefined
    if (!current || current.revision !== record.revision) {
      return {
        target,
        status: 'changed-since',
        ...(current
          ? { laterOpId: current.opId }
          : { detail: 'Its history no longer reaches back to this change.' })
      }
    }
    // Why per target: one tag change may add different tags (one target per session and tag).
    undo.push({ target, value: toggle ? organizationValueAt(record, index) : record.before[index] })
    return {
      target,
      status: 'undo',
      ...(record.after && index < record.after.length ? { expected: record.after[index] } : {})
    }
  })
  const values = undo.map((entry) => entry.value)
  const uniform = values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))
  return {
    opId: record.opId,
    inverse:
      undo.length > 0 && kind
        ? {
            kind,
            targets: undo.map((entry) => entry.target),
            value: values[0],
            ...(uniform ? {} : { values }),
            undoOf: record.opId,
            ...(record.revision ? { expectedRevision: record.revision } : {})
          }
        : null,
    targets,
    partial: undo.length > 0 && undo.length < record.targets.length
  }
}

export type OrganizationValueRead = { known: true; value: unknown } | { known: false }

export type OrganizationUndoSelection = {
  /** The inverse for the targets that still hold what the change left; null when none do. */
  change: Omit<OrganizationChange, 'opId' | 'executor'> | null
  kept: number
  total: number
  /** Changed since, or not undoable: never overwritten. */
  skipped: OrganizationUndoTarget[]
}

/**
 * The window and the host undo the same way: main's plan puts back only targets nothing recorded
 * a change to since, and each of those is read again, so a change made by a path that records
 * nothing is skipped too, never overwritten.
 */
export function selectOrganizationUndo(
  plan: OrganizationUndoPlan,
  readNow: (
    kind: OrganizationChangeKind,
    target: OrganizationTarget,
    value: unknown
  ) => OrganizationValueRead,
  changedHere: string
): OrganizationUndoSelection {
  const skipped = plan.targets.filter((entry) => entry.status !== 'undo')
  const total = plan.targets.length
  const inverse = plan.inverse
  if (!inverse) {
    return { change: null, kept: 0, total, skipped }
  }
  // Why by index: the inverse lists exactly the plan's `undo` targets, in order.
  const planned = plan.targets.filter((entry) => entry.status === 'undo')
  const keep: number[] = []
  inverse.targets.forEach((target, index) => {
    const entry = planned[index]
    const now = readNow(
      inverse.kind,
      target,
      inverse.values ? inverse.values[index] : inverse.value
    )
    const unchanged =
      entry !== undefined &&
      now.known &&
      (!('expected' in entry) || JSON.stringify(now.value) === JSON.stringify(entry.expected))
    if (unchanged) {
      keep.push(index)
    } else {
      skipped.push({ target, status: 'changed-since', detail: changedHere })
    }
  })
  if (keep.length === 0) {
    return { change: null, kept: 0, total, skipped }
  }
  const values = keep.map((index) => (inverse.values ? inverse.values[index] : inverse.value))
  return {
    change: {
      ...inverse,
      targets: keep.map((index) => inverse.targets[index]!),
      value: values[0],
      ...(inverse.values ? { values } : {})
    },
    kept: keep.length,
    total,
    skipped
  }
}
