import { join } from 'node:path'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { RemoteConversationLedgerStore } from './remote-conversation-ledger-store'
import { getRemoteSessionHosts } from './remote-session-hosts-runtime'

let store: RemoteConversationLedgerStore | null = null

/**
 * The receiver snapshots of paired owners' ledgers (session parity, step 5), beside the owner
 * runtime's own session-host state: `<userData>/session-host/ledgers`. The owner's journal hostId
 * comes from this computer's latest negotiation with it (`sessionHosts.status` readings). Only
 * owners still in the pairing catalog are read: a re-pair mints a new environment id (C11), and
 * the old id's file stays on disk for G4 without being parsed or shipped to the window.
 */
export function getRemoteConversationLedgerStore(): RemoteConversationLedgerStore {
  store ??= new RemoteConversationLedgerStore({
    directory: join(getProfileUserDataPath(), 'session-host', 'ledgers'),
    resolveOwnerHostId: (environmentId) =>
      getRemoteSessionHosts()?.snapshots([`runtime:${environmentId}`])[0]?.hostId ?? null,
    isKept: (environmentId) =>
      listEnvironments(getProfileUserDataPath()).some((entry) => entry.id === environmentId)
  })
  return store
}

/** The store if a window ever asked main to keep a snapshot this run; null otherwise (quit). */
export function peekRemoteConversationLedgerStore(): RemoteConversationLedgerStore | null {
  return store
}
