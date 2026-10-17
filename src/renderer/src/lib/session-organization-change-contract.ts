/**
 * The change path's contract (design: docs/reference/session-organization-change-path.md): what
 * a caller passes and gets back, and the revision check the ownership mirror installs.
 */

import type {
  OrganizationChange,
  OrganizationTarget
} from '../../../shared/session-organization-change'
import type { OrganizationAppliedListener } from './session-organization-applied'
import type { OrganizationStoreAction, OrganizationStores } from './session-organization-values'

export type OrganizationRpc = <T>(method: string, params?: unknown) => Promise<T>

/** Null allows; text refuses. WP-B installs the ownership-mirror check. */
export type OrganizationRevisionCheck = (
  target: OrganizationTarget,
  expectedRevision: string,
  change: OrganizationChange
) => string | null

export type OrganizationChangeDeps = {
  stores?: OrganizationStores
  rpc?: OrganizationRpc
  checkRevision?: OrganizationRevisionCheck
  mintOpId?: () => string
  /** Applies through a specific store action instead of the kind's generic applier. */
  act?: OrganizationStoreAction
  /** Defaults to the installed one (the ownership mirror). */
  onApplied?: OrganizationAppliedListener
  /** A person's change applied but could not be recorded. */
  onRecordFailure?: (message: string) => void
}

export type OrganizationChangeRequest = Omit<OrganizationChange, 'opId'> & { opId?: string }

export type OrganizationChangeOutcome =
  | {
      status: 'applied'
      opId: string
      before: unknown[]
      after: unknown[]
      revision?: string
      /** Applied, but the record could not be written. */
      recordError?: string
      /** Some targets were refused by the store. */
      error?: string
    }
  /** Nothing changed: a revision mismatch, or it could not be recorded first. */
  | { status: 'refused'; opId: string; error: string }
  /** Nothing changed: the stores refused it. */
  | { status: 'failed'; opId: string; error: string }

// Why allow by default: until ownership is tracked (WP-B) no revision can be stale.
let installedRevisionCheck: OrganizationRevisionCheck | null = null

export function setOrganizationRevisionCheck(check: OrganizationRevisionCheck | null): void {
  installedRevisionCheck = check
}

/** The first refusal from the revision check, for a change that names an expected revision. */
export function checkOrganizationRevision(
  change: OrganizationChange,
  check: OrganizationRevisionCheck | null | undefined = installedRevisionCheck
): string | null {
  if (!change.expectedRevision || !check) {
    return null
  }
  for (const target of change.targets) {
    const refusal = check(target, change.expectedRevision, change)
    if (refusal) {
      return refusal
    }
  }
  return null
}
