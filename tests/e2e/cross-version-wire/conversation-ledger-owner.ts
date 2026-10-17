import { conversationLedgerStatusCapabilities } from '../../../src/main/runtime/session-conversation-ledger-runtime'
import { SessionConversationLedgerStore } from '../../../src/main/runtime/session-conversation-ledger-store'
import { sessionConversationIdentity } from '../../../src/shared/session-conversation-ledger'

/**
 * The owner side of the `session.tabs.listAll` skew for the conversation ledger (session parity,
 * E3): one empty workspace frame that any build's listAll can serve, and — when asked — the
 * conversation ledger store current source reads, holding one listed conversation and one
 * tombstone, so a build whose own list names the capability has something to publish.
 */

const WORKSPACE = 'repo::/ledger-skew'
/** A provider-less pane's identity: it must never reach a client that did not ask. */
export const LEDGER_SKEW_PANE_IDENTITY = 'pane:ledger-skew-tab:leaf-1'

function ownerLedger(): SessionConversationLedgerStore {
  const providerSession = { key: 'session_id' as const, id: 'ledger-skew-1' }
  const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
  // A desktop owner: its ledger publisher runs, so its status names the capability.
  store.installOwnerPublisher()
  store.publishWindow({
    rendererGeneration: 'r1',
    listedAt: 1,
    coverage: [{ worktreeId: WORKSPACE, complete: true }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree: {
      [WORKSPACE]: [
        {
          conversation: sessionConversationIdentity({
            worktreeId: WORKSPACE,
            agent: 'claude',
            providerSession
          }),
          agent: 'claude',
          providerSession,
          title: 'Claude',
          titleSource: 'terminal',
          surface: 'record',
          rest: 'asleep',
          listed: true,
          updatedAt: 1
        }
      ]
    }
  })
  store.setRemovals(
    [{ paneIdentity: LEDGER_SKEW_PANE_IDENTITY, worktreeId: WORKSPACE, at: 2 }],
    false
  )
  return store
}

/**
 * What current source's ledger owner adds to its build's capability list in `runtime.status`
 * (`conversationLedgerStatusCapabilities`, the call getStatus makes), derived from the status
 * rule itself rather than from RUNTIME_CAPABILITIES, which no longer names the ledger.
 */
export function conversationLedgerOwnerStatusCapabilities(): string[] {
  return conversationLedgerStatusCapabilities(ownerLedger())
}

/** A runtime both builds' listAll runs on; `withLedger` adds the store current source reads. */
export function conversationLedgerOwnerRuntime(withLedger: boolean): Record<string, unknown> {
  const frame = {
    worktree: WORKSPACE,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
  const store = withLedger ? ownerLedger() : null
  return {
    getRuntimeId: () => 'runtime-ledger-owner',
    restoreStructuredAgentSessionTabs: async () => undefined,
    supportsAuthoritativeSessionTabsInventory: () => true,
    listAllMobileSessionTabsInventory: async () => ({ snapshots: [frame], authoritative: true }),
    listAllMobileSessionTabs: async () => [frame],
    ...(store ? { getSessionConversationLedgerStore: () => store } : {})
  }
}
