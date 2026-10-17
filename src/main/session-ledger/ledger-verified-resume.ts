import type { LedgerPaneEntry } from './ledger-identity'
import { claudeSessionFileExists } from '../claude/claude-resume-identity'
import {
  readLedgerResumeIdentity,
  type LedgerResumeIdentity,
  type PersistedPane
} from './ledger-pane-store'

export function verifiedLedgerResumeIdentity(value: unknown): LedgerResumeIdentity | null {
  const identity = readLedgerResumeIdentity(value)
  if (!identity || identity.agent !== 'claude' || identity.connectionId) {
    return identity
  }
  return claudeSessionFileExists(identity.sessionFilePath) ? identity : null
}

export function updateLedgerResumeIdentity(
  entry: LedgerPaneEntry,
  patch: Partial<LedgerPaneEntry>
): void {
  const verified = verifiedLedgerResumeIdentity(entry)
  const changedSession = patch.nativeSessionId && patch.nativeSessionId !== entry.nativeSessionId
  const changedAgent = patch.agent && patch.agent !== entry.agent
  Object.assign(entry, patch)
  if (changedAgent) {
    entry.verifiedResumeIdentity = undefined
  } else if (changedSession && verified) {
    entry.verifiedResumeIdentity = verified
  } else {
    entry.verifiedResumeIdentity ??= verifiedLedgerResumeIdentity(entry) ?? undefined
  }
}

export function persistLedgerPane(entry: LedgerPaneEntry): PersistedPane {
  const current = readLedgerResumeIdentity(entry)
  const fallback = verifiedLedgerResumeIdentity(entry.verifiedResumeIdentity)
  const resume =
    verifiedLedgerResumeIdentity(current) ??
    fallback ??
    (!current?.sessionFilePath ? current : null)
  return {
    paneKey: entry.paneKey,
    ledgerId: entry.ledgerId,
    repo: entry.repo,
    branch: entry.branch,
    cardId: entry.cardId,
    cardTitle: entry.cardTitle,
    ...(resume ? { resumeIdentity: resume } : {}),
    ...(fallback ? { verifiedResumeIdentity: fallback } : {}),
    cardLinkedBy: entry.cardLinkedBy,
    account: entry.account,
    startedAt: entry.startedAt
  }
}
