import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  inventoryConfirmsWorkspaceAbsence,
  isUnpublishedWorkspacePlaceholder,
  readSessionTabsInventoryCoverage,
  type SessionTabsInventoryAbsenceEvidence
} from '../../../shared/session-tabs-absence-evidence'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/**
 * Receiver side of scoped absence authority (session-count fix step 6, C4). A mirrored row leaves
 * only on its owner's evidence; an omission the owner cannot vouch for keeps the row, flags it
 * "can't verify" and keeps it from being woken until a later frame lists it again or proves it gone.
 */

/** The evidence a full inventory carries, read defensively: anything malformed is unknown. */
export function readInventoryAbsenceEvidence(inventory: {
  authoritative?: unknown
  coverage?: unknown
}): SessionTabsInventoryAbsenceEvidence {
  const coverage = readSessionTabsInventoryCoverage(inventory.coverage)
  return {
    ...(inventory.authoritative === true ? { authoritative: true } : {}),
    ...(coverage ? { coverage } : {})
  }
}

/** Splits workspaces an inventory omitted into proven-gone and unverifiable. */
export function partitionInventoryOmissions<T extends { worktree: string }>(
  omitted: readonly T[],
  evidence: SessionTabsInventoryAbsenceEvidence
): { confirmed: T[]; unverified: T[] } {
  const confirmed: T[] = []
  const unverified: T[] = []
  for (const entry of omitted) {
    if (inventoryConfirmsWorkspaceAbsence(evidence, entry.worktree)) {
      confirmed.push(entry)
    } else {
      unverified.push(entry)
    }
  }
  return { confirmed, unverified }
}

/** Frame-log reason for a frame whose omissions are retained (step 0 receiver reasons). */
export function unverifiedMembershipReason(snapshot: RuntimeMobileSessionTabsResult): string {
  return isUnpublishedWorkspacePlaceholder(snapshot)
    ? 'unpublished-placeholder-retains-omissions'
    : 'owner-membership-unverified-retains-omissions'
}

/** The rows with `ids` flagged as unverified; the same array when nothing changes. */
export function flagMirrorAbsenceUnverified(
  tabs: TerminalTab[],
  ids: ReadonlySet<string>
): TerminalTab[] {
  if (ids.size === 0 || !tabs.some((tab) => ids.has(tab.id) && !tab.mirrorAbsenceUnverified)) {
    return tabs
  }
  return tabs.map((tab) =>
    ids.has(tab.id) && !tab.mirrorAbsenceUnverified
      ? { ...tab, mirrorAbsenceUnverified: true }
      : tab
  )
}
