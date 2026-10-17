// What this window's own conversation ledger last published (session parity, step 8). The owner's
// counts report each listed conversation's rest exactly as its paired computers received it, so a
// parity check compares the owner's word with the copy a receiver holds, never a second reading of
// liveness taken some other way (the publisher's rest needs main's PTY census, F16).

import type {
  SessionConversationLedgerWindowPublication,
  SessionConversationRest
} from '../../../shared/session-conversation-ledger'
import { sessionParityRecordIdentity } from '../../../shared/session-parity'

let latest: SessionConversationLedgerWindowPublication | null = null
let restByIdentity: Map<string, SessionConversationRest> | null = null

function identityKey(worktreeId: string, identity: string): string {
  return JSON.stringify([worktreeId, identity])
}

export function rememberPublishedConversationLedger(
  publication: SessionConversationLedgerWindowPublication
): void {
  latest = publication
  restByIdentity = null
}

/** The rest a listed record carried, by workspace and tagged identity (`c:` / `p:`). */
export function publishedConversationLedgerRest(
  worktreeId: string,
  identity: string
): SessionConversationRest | undefined {
  if (!latest) {
    return undefined
  }
  if (!restByIdentity) {
    restByIdentity = new Map()
    for (const [bucket, records] of Object.entries(latest.recordsByWorktree)) {
      for (const record of records) {
        const tag = record.listed ? sessionParityRecordIdentity(record) : null
        if (tag) {
          restByIdentity.set(identityKey(bucket, tag), record.rest)
        }
      }
    }
  }
  return restByIdentity.get(identityKey(worktreeId, identity))
}

export function _resetPublishedConversationLedgerForTests(): void {
  latest = null
  restByIdentity = null
}
