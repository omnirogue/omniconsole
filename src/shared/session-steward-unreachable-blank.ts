/**
 * The steward's third archive rule: a blank session on an SSH host this computer has not reached
 * for a day. It files the row here only; the remote process is never claimed stopped, and when
 * the host is back the blank-session rule closes it properly. Main writes the reason and token,
 * and the window's last check reads them.
 */
import { archiveProofDigest } from './session-archive-proof-digest'
import type { OrganizationChange } from './session-organization-change'

export const STEWARD_UNREACHABLE_BLANK_REASON =
  'blank session on an SSH host unreachable for a day: archived on this computer only; its remote process was not stopped'
export const STEWARD_UNREACHABLE_BLANK_EVIDENCE = 'blank on an unreachable host'
export const UNREACHABLE_BLANK_ARCHIVE_MS = 24 * 60 * 60_000

/** The token main writes at its judgment and the window re-reads before filing. */
export function unreachableBlankEvidence(key: string, revision: string): string {
  return `${STEWARD_UNREACHABLE_BLANK_EVIDENCE} #${archiveProofDigest(JSON.stringify([key, revision]))}`
}

/** Names the row a grant was made for, so the settle recheck confirms the same one. */
export function unreachableBlankRowMarker(key: string): string {
  return `row ${archiveProofDigest(key).slice(0, 8)}`
}

/** When the grant was made, this computer had last reached the host then (or never). */
export function unreachableBlankReachMarker(lastReachedAt: number | null): string {
  return `reached ${lastReachedAt ?? 'never'}`
}

export function isStewardUnreachableBlankArchive(
  change: Pick<OrganizationChange, 'executor' | 'reason'>
): boolean {
  return (
    change.executor.kind === 'app' &&
    change.executor.feature === 'steward' &&
    change.reason === STEWARD_UNREACHABLE_BLANK_REASON
  )
}

/** The window's persisted clock for one row: valid only while its revision still holds. */
export type UnreachableBlankClock = { revision: string; since: number }
