import { archiveProofDigest } from './session-archive-proof-digest'

/** Device/account policy; absence of a current clock never means the delay has elapsed. */
export type SessionDoneArchiveClock = { revision: string; since: number }
export type SessionDoneArchivePolicy = SessionDoneArchiveClock & { delayMs: number }

export const DONE_ARCHIVE_DEFAULT_MINUTES = 120
export const DONE_ARCHIVE_MAX_MINUTES = 30 * 24 * 60

export function doneArchiveDue(
  policy: SessionDoneArchivePolicy | null | undefined,
  now: number
): boolean {
  return (
    !!policy &&
    Number.isFinite(policy.since) &&
    Number.isFinite(policy.delayMs) &&
    policy.delayMs > 0 &&
    policy.since > 0 &&
    policy.since <= now &&
    now - policy.since >= policy.delayMs
  )
}

export function doneArchiveEvidence(key: string, clock: SessionDoneArchiveClock): string {
  return `Done clock #${archiveProofDigest(JSON.stringify([key, clock.revision, clock.since]))}`
}

/** The audit reason of a planned conversation's archive: its host proved the whole commitment. */
export const DONE_ARCHIVE_PROVEN_REASON =
  'Continuously Done with verified outcomes and no attention obligations'

/**
 * The audit reason of an everyday conversation's archive (no outcome plan): its host read it idle
 * with nothing pending. The window's final check reads this reason to re-verify it has no plan.
 */
export const DONE_ARCHIVE_IDLE_REASON = 'Continuously Done, idle, nothing pending (no plan)'

/**
 * An idle archive's receipt. `advisory:` because no plan proves it: any later status report, or a
 * plan appearing, brings the row back (`applyAutomaticSessionArchives`).
 */
export function idleArchiveReceipt(key: string, clock: SessionDoneArchiveClock): string {
  return `advisory:idle ${doneArchiveEvidence(key, clock)}`
}

export function isIdleArchiveReceipt(proof: string): boolean {
  return proof.startsWith('advisory:idle ')
}
