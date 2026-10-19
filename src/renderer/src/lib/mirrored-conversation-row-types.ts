import type { AppState } from '@/store'
import type {
  MirroredConversationOwnerState,
  MirroredConversationUnverifiedReason
} from '@/store/slices/mirrored-conversation-ledger'
import type {
  SessionConversationLedgerFolder,
  SessionConversationRest
} from '../../../shared/session-conversation-ledger'

/**
 * What a paired owner's conversation ledger says about one sidebar row (session parity, step 6).
 * Present only on a row the ledger vouches for: a mirror row it joined, a row it created, or a
 * receiver capture of a conversation the owner holds without listing it (`listed: false`, G1).
 * Step 8 buckets rows by it; actions read it to address the owner, never to act here.
 */
export type MirroredSidebarConversation = {
  environmentId: string
  /** The owner's full-claim digest; null for a pane with no provider session yet. */
  conversation: string | null
  /** `pane:<owner paneKey>`: the identity of a provider-less pane (F21 `p:`). */
  paneIdentity?: string
  ownerPaneKey: string | null
  ownerTabId: string | null
  rest: SessionConversationRest
  // Why tri-state: absent means the owner did not say, so the last known placement stands.
  archivedByOwner?: boolean
  /** The owner's folder; null is explicitly unfiled. */
  folderIdByOwner?: string | null
  /** The owner's definition of that folder, shown read-only until account sync brings it. */
  folderByOwner?: SessionConversationLedgerFolder
  hidden?: boolean
  /** The owner noted an agent launched it: it lists in Agent sessions here too. */
  agentSessionByOwner?: boolean
  /** False: the owner holds it as passive evidence and does not list it (bucket heldByOwner). */
  listed: boolean
  /** Restored from the durable snapshot and not confirmed live since: "as of", never retires. */
  stale: boolean
  /** The owner's state as this receiver knows it (G2). */
  ownerState: MirroredConversationOwnerState
  unverified?: MirroredConversationUnverifiedReason
}

/**
 * The store slices the ledger rows read. Optional so partial store doubles keep working: absent
 * means "no ledger received". Beyond the ledger, `resolveWebTerminalSurfaceTabIdForHost` reads
 * the mirror tab evidence and the paired-environment catalog to find an owner's mirror tab (F8).
 */
export type MirroredConversationRowSource = Partial<
  Pick<
    AppState,
    | 'mirroredConversationLedgerByOwner'
    | 'mirroredConversationOwnersByEnvironment'
    | 'ptyIdsByTabId'
    | 'runtimeEnvironments'
    | 'runtimeEnvironmentCatalogHydrated'
    | 'removedRuntimeEnvironmentIds'
  >
>
