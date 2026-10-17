/**
 * The steward's blank-session rule, as main records it and the renderer's final check reads it:
 * the change's reason names the rule (archive or close), and its evidence carries this marker.
 */
import { archiveProofDigest } from './session-archive-proof-digest'
import type { OrganizationChange } from './session-organization-change'

export const STEWARD_EMPTY_SESSION_REASON = 'empty session: started with no prompt'
/**
 * Recorded before the close, so it claims no outcome: whether its agent stopped is known only
 * once its provider or SSH host confirms the exit (the steward's activity line says which).
 */
export const STEWARD_EMPTY_SESSION_CLOSE_REASON =
  'blank session: nobody prompted it, so the steward closed its tab'
export const STEWARD_EMPTY_SESSION_EVIDENCE = 'nobody prompted it'

/** The evidence token main writes at its judgment and the window re-reads before filing. */
export function emptySessionEvidence(key: string, revision: string): string {
  return `${STEWARD_EMPTY_SESSION_EVIDENCE} #${archiveProofDigest(JSON.stringify([key, revision]))}`
}

function isSteward(change: Pick<OrganizationChange, 'executor'>): boolean {
  return change.executor.kind === 'app' && change.executor.feature === 'steward'
}

export function isStewardEmptySessionArchive(
  change: Pick<OrganizationChange, 'executor' | 'reason'>
): boolean {
  return isSteward(change) && change.reason === STEWARD_EMPTY_SESSION_REASON
}

export function isStewardEmptySessionClose(
  change: Pick<OrganizationChange, 'executor' | 'reason'>
): boolean {
  return isSteward(change) && change.reason === STEWARD_EMPTY_SESSION_CLOSE_REASON
}
