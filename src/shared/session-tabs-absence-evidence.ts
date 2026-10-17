import { getRepoIdFromWorktreeId } from './worktree/id'
import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
} from './runtime-session-contracts'

/**
 * Scoped absence evidence for session-tabs inventories (session-count fix step 6, C4).
 *
 * A row may leave a mirror only on owner evidence scoped to it: complete inventory coverage for an
 * omitted workspace, complete workspace membership for an omitted tab, or an explicit removal
 * receipt. Process-census completeness is scoped to the execution host that runs the workspace, so
 * one unreachable SSH host makes only its own workspaces unverifiable. Missing evidence (an older
 * owner, or a client that did not negotiate it) means unknown: the row is kept, labelled, and never
 * woken. Mirror removal is a visibility fact, never process-exit evidence.
 */

/**
 * Carried on a full inventory whose owner publication was current for the whole collection but
 * whose process census missed some execution hosts. Every workspace the inventory omits is
 * confirmed absent except those in the unverified scope: any worktree of a listed repo, or a
 * listed workspace key (folder workspaces and workspaces whose host is unknown).
 */
export type SessionTabsInventoryCoverage = {
  unverifiedRepoIds: string[]
  unverifiedWorkspaces: string[]
}

export type SessionTabsInventoryAbsenceEvidence = {
  /** The whole inventory is complete (existing negotiated label). */
  authoritative?: boolean
  coverage?: SessionTabsInventoryCoverage
}

type SnapshotMembership = {
  publicationEpoch: string
  membershipUnverified?: unknown
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** A malformed coverage reads as absent: unknown, never complete. */
export function readSessionTabsInventoryCoverage(
  value: unknown
): SessionTabsInventoryCoverage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const { unverifiedRepoIds, unverifiedWorkspaces } = value as Record<string, unknown>
  return isStringArray(unverifiedRepoIds) && isStringArray(unverifiedWorkspaces)
    ? { unverifiedRepoIds, unverifiedWorkspaces }
    : undefined
}

export function isWorkspaceInUnverifiedCoverageScope(
  coverage: SessionTabsInventoryCoverage,
  worktreeId: string
): boolean {
  return (
    coverage.unverifiedWorkspaces.includes(worktreeId) ||
    coverage.unverifiedRepoIds.includes(getRepoIdFromWorktreeId(worktreeId))
  )
}

/** Whether an inventory that omits `worktreeId` proves the owner no longer publishes it. */
export function inventoryConfirmsWorkspaceAbsence(
  inventory: SessionTabsInventoryAbsenceEvidence,
  worktreeId: string
): boolean {
  if (inventory.authoritative === true) {
    return true
  }
  const coverage = readSessionTabsInventoryCoverage(inventory.coverage)
  return coverage !== undefined && !isWorkspaceInUnverifiedCoverageScope(coverage, worktreeId)
}

/**
 * The placeholder a runtime answers for a workspace it has not published yet. Read by base epoch:
 * the per-device navigation projection rewrites it to `none:client-navigation` and adds that
 * device's revision to its version, and no real publication ever uses the literal `none` epoch.
 */
export function isUnpublishedWorkspacePlaceholder(snapshot: { publicationEpoch: string }): boolean {
  const epoch = snapshot.publicationEpoch
  const base = epoch.endsWith(CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX)
    ? epoch.slice(0, -CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX.length)
    : epoch
  return base === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
}

/**
 * Whether a per-workspace frame is the owner's complete membership, so a tab it omits is gone.
 * Two shapes say otherwise: the placeholder a runtime answers before it has published the
 * workspace at all, and a publication its owner marks as missing an execution host's census.
 */
export function snapshotAffirmsWorkspaceMembership(snapshot: SnapshotMembership): boolean {
  return !isUnpublishedWorkspacePlaceholder(snapshot) && snapshot.membershipUnverified !== true
}
