import { verifiedLedgerResumeIdentity } from './ledger-verified-resume'
import type { LedgerPaneEntry } from './ledger-identity'
import { readLedgerResumeIdentity, type PersistedPane } from './ledger-pane-store'

/** Historical identity is retained without reviving an old process. */
export function restoreLedgerPane(pane: PersistedPane): LedgerPaneEntry {
  const candidate = readLedgerResumeIdentity(pane.resumeIdentity)
  const verified = verifiedLedgerResumeIdentity(pane.verifiedResumeIdentity)
  // Why candidate-gated: an older row with no resume identity must stay identity-free; the
  // verified fallback only replaces a recorded candidate whose session file is gone.
  const resume = candidate
    ? (verifiedLedgerResumeIdentity(candidate) ??
      verified ??
      (candidate.sessionFilePath ? null : candidate))
    : null
  return {
    paneKey: pane.paneKey,
    ledgerId: pane.ledgerId,
    attemptId: '',
    ptyId: null,
    remote: resume?.connectionId != null,
    cwd: null,
    repo: pane.repo ?? null,
    branch: pane.branch ?? null,
    cardId: pane.cardId ?? null,
    cardTitle: typeof pane.cardTitle === 'string' ? pane.cardTitle : null,
    // Why: a person's link outlives a restart exactly as far as its card_id does; anything
    // else on disk is treated as unowned, so the workspace decides it again.
    cardLinkedBy: pane.cardLinkedBy === 'person' ? 'person' : null,
    worktreeId: resume?.worktreeId ?? null,
    agent: resume?.agent ?? null,
    model: null,
    nativeSessionId: resume?.nativeSessionId ?? null,
    sessionFilePath: resume?.sessionFilePath,
    verifiedResumeIdentity: verified ?? undefined,
    nativeSessionKey: resume?.nativeSessionKey ?? null,
    connectionId: resume?.connectionId,
    account: pane.account ?? null,
    restored: true,
    startedAt: pane.startedAt,
    started: false,
    pendingStart: null,
    attemptReason: 'resume',
    ended: false
  }
}
