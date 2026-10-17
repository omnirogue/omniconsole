import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE,
  readSessionConversationLedgerPublication
} from '../../shared/session-conversation-ledger'
import { SessionConversationLedgerStore } from './session-conversation-ledger-store'

/**
 * The runtime's wiring for its own conversation ledger (session parity, step 2), kept out of
 * omni-runtime.ts: one store per runtime, kept on disk beside the owner runtime's other
 * session-host state, and the gate a window publication passes before it reaches the store.
 */

/** `<userData>/session-host/owner-ledger.json`; null with no profile (a plain Node fork). */
export function ownerConversationLedgerPath(): string | null {
  return hasAppEnvironment()
    ? join(getAppEnvironment().getPath('userData'), 'session-host', 'owner-ledger.json')
    : null
}

export function createSessionConversationLedgerStore(): SessionConversationLedgerStore {
  return new SessionConversationLedgerStore({ ownerLedgerPath: ownerConversationLedgerPath() })
}

/**
 * What the ledger adds to a runtime's status capabilities: its capability only while an owner
 * publisher runs (startOwnerConversationLedger), as the session host's are pushed only once an
 * executor runs. Why: orcad builds the same runtime but publishes no ledger, and a receiver would
 * read its empty set as an owner with nothing (session parity).
 */
export function conversationLedgerStatusCapabilities(
  store: Pick<SessionConversationLedgerStore, 'hasOwnerPublisher'> | null
): string[] {
  return store?.hasOwnerPublisher() ? [SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY] : []
}

/**
 * The authoritative window's whole ledger, as `syncSessionWorkflowRecords` gates workflow records:
 * only the renderer generation whose graph this runtime holds may publish; an earlier one (before
 * a reload), another window, or one whose graph is not ready is refused with
 * `session_conversation_ledger_publisher_not_current` and retries. True when the set changed.
 */
export function syncWindowConversationLedger(
  store: SessionConversationLedgerStore,
  publication: unknown,
  publisher: { current: boolean; rendererGeneration: string | null }
): boolean {
  const read = readSessionConversationLedgerPublication(publication)
  if (!read) {
    throw new Error('Invalid conversation ledger publication')
  }
  if (!publisher.current || read.rendererGeneration !== publisher.rendererGeneration) {
    throw new Error(SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE)
  }
  return store.publishWindow(read)
}
