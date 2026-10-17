import type { OrganizationChange } from '../../../shared/session-organization-change'

type ArchiveChecks = {
  refusal: (change: OrganizationChange) => string | null
  receipt: (key: string) => string
}
let checks: ArchiveChecks | null = null

/** Installed by the finish lifecycle, avoiding organization/store import cycles. */
export function setAutomaticArchiveChecks(next: ArchiveChecks): () => void {
  checks = next
  return () => {
    if (checks === next) {
      checks = null
    }
  }
}

export function automaticArchiveRefusal(change: OrganizationChange): string | null {
  if (
    change.kind !== 'archive' ||
    change.executor.kind !== 'app' ||
    !['auto-archive', 'steward'].includes(change.executor.feature)
  ) {
    return null
  }
  return checks ? checks.refusal(change) : 'The automatic archive safety check is not ready.'
}

export function automaticArchiveReceipt(key: string): string {
  if (!checks) {
    throw new Error('The automatic archive safety check is not ready.')
  }
  return checks.receipt(key)
}
