/**
 * Owner conversation ledger on the session-tabs wire (session parity, step 1): the contract. Each
 * owner lists every conversation its own sidebar shows under `local` — live tabs, dormant tabs,
 * slept tabs and tab-less sleeping records — one record per provider conversation, with its rest,
 * the owner's own archive mark, folder, saved/hidden flags, a sanitized title and the owner pane,
 * so a tab-surface record joins the mirrored row a paired computer already built. It rides where
 * `workflowRecords` rides: a `conversationLedger` field on `session.tabs.listAll` and on the
 * `snapshots` event of `session.tabs.subscribeAll`, then one negotiated `conversationLedger` event
 * per change (a whole set or a per-workspace delta), all gated by
 * `session-tabs.conversation-ledger.v1`.
 *
 * Completeness is per workspace (`coverage`), never host-wide. A new `generation` restarts
 * revision ordering and by itself removes nothing; a receiver removes a row or retires its own
 * capture only on owner evidence: a `source: 'window'` set received live on its connection that
 * covers that workspace with `complete: true` and lists the conversation nowhere, or a deletion
 * tombstone in `removals` (session-conversation-ledger-removals.ts), which removes the row and its
 * capture whatever the source or coverage. A `main` set, an incomplete bucket and a restored
 * snapshot add, update and vouch; an ordinary omission from them removes nothing. Only the owner
 * publishes its own ledger;
 * a receiver never republishes a peer's. Nothing on this wire carries a prompt, launch
 * configuration, agent arguments or environment, transcript path, assistant message or project
 * setting; the readers (session-conversation-ledger-readers.ts) pick the known fields and drop
 * everything else.
 */

import type { AgentProviderSessionKey, AgentProviderSessionMetadata } from './agent-session-resume'
import { getProviderSessionClaimKey } from './provider-session-claim-key'
import type { SessionArchiveProjection } from './session-archive-projection'
import { sha256 } from './sha256'

/** The window → its own main process publication channel (never crosses a paired transport). */
export const SESSION_CONVERSATION_LEDGER_SYNC_CHANNEL = 'runtime:syncSessionConversationLedger'
/** The subscribeAll event (and listAll field) carrying the owner's ledger. */
export const SESSION_CONVERSATION_LEDGER_EVENT = 'conversationLedger'
/** Main refuses a publication from a window or renderer generation whose graph it does not hold. */
export const SESSION_CONVERSATION_LEDGER_PUBLISHER_NOT_CURRENT_CODE =
  'session_conversation_ledger_publisher_not_current'

export const SESSION_CONVERSATION_RESTS = ['live', 'dormant', 'asleep', 'unknown'] as const
export type SessionConversationRest = (typeof SESSION_CONVERSATION_RESTS)[number]
export const SESSION_CONVERSATION_SURFACES = ['tab', 'record'] as const
export type SessionConversationSurface = (typeof SESSION_CONVERSATION_SURFACES)[number]
export const SESSION_CONVERSATION_TITLE_SOURCES = [
  'custom',
  'terminal',
  'generated',
  'agent'
] as const
export type SessionConversationTitleSource = (typeof SESSION_CONVERSATION_TITLE_SOURCES)[number]
export const SESSION_CONVERSATION_LEDGER_SOURCES = ['window', 'main'] as const
export type SessionConversationLedgerSource = (typeof SESSION_CONVERSATION_LEDGER_SOURCES)[number]
export const SESSION_CONVERSATION_PROVIDER_SESSION_KEYS = [
  'session_id',
  'conversation_id'
] as const satisfies readonly AgentProviderSessionKey[]

/** Wire caps: a publisher cuts here and names what it cut; a reader cuts here again and marks it. */
export const SESSION_CONVERSATION_LEDGER_LIMITS = {
  recordsPerWorkspace: 1000,
  workspaces: 2000,
  /** Why a total cap: bounds every set on the wire; what it cuts is named, never silently absent. */
  totalRecords: 8000,
  title: 200,
  folderName: 80,
  folders: 500,
  projects: 500,
  id: 200,
  paneKey: 300,
  worktreeId: 1000,
  /** Tombstones a set or delta carries (the owner's last 90 days); the newest by `at` are kept. */
  removals: 2000
} as const

/** 12 bytes of sha256 as hex (the account-sync session-key size): collision-safe for one owner. */
const IDENTITY_BYTES = 12

/** The provider conversation on the wire: only its key kind and id (never a transcript path). */
export type SessionConversationProviderSession = Pick<AgentProviderSessionMetadata, 'key' | 'id'>

/** The owner's archive mark: explicit true or false; `byHand` when the owner knows it. */
export type SessionConversationArchiveMark = Pick<SessionArchiveProjection, 'archived'> &
  Partial<Pick<SessionArchiveProjection, 'byHand'>>

export type RuntimeSessionConversationRecord = {
  /** `sessionConversationIdentity`: the owner's full-claim digest, opaque; null until the agent reports a session. */
  conversation: string | null
  /** `pane:<paneKey>`: the identity of a tab-surface record (always when `paneKey` is known). */
  paneIdentity?: string
  agent: string
  providerSession: SessionConversationProviderSession | null
  title: string
  titleSource: SessionConversationTitleSource
  surface: SessionConversationSurface
  /** The owner's pane and tab, so a tab-surface record joins the mirrored row of that tab. */
  paneKey?: string
  tabId?: string
  rest: SessionConversationRest
  interrupted?: true
  // Why tri-state organization fields: absent means the owner did not say (a receiver keeps its
  // last known value); only an explicit value, including `false` and `null`, replaces it.
  archived?: SessionConversationArchiveMark
  /** The owner's folder; `null` is explicitly unfiled, absent is unknown. */
  folderId?: string | null
  saved?: boolean
  hidden?: boolean
  /** An agent launched it (the owner's Agent sessions); absent from an older owner. */
  agentSession?: true
  /** False for passive completed hibernation evidence the owner holds but does not list (G1). */
  listed: boolean
  updatedAt: number
}

export type SessionConversationLedgerCoverage = { worktreeId: string; complete: boolean }
export type SessionConversationLedgerFolder = {
  id: string
  name: string
  parentId?: string
  section?: 'saved' | 'active'
}
/** Presentation only: which folders are projects. Settings never cross (instructions, attachments). */
export type SessionConversationLedgerProject = { folderId: string; displayName?: string }
/** Rows the owner's sidebar lists but the ledger leaves out, counted so no total reads smaller. */
export type SessionConversationLedgerOmitted = { unknownHost: number; unverified: number }

/** What the window sends its own main process: everything but the ordering main assigns. */
export type SessionConversationLedgerWindowPublication = {
  /** The renderer generation of the graph main holds; any other is refused. */
  rendererGeneration: string
  listedAt: number
  /** Every workspace the owner speaks for; `complete:false` adds and updates but removes nothing. */
  coverage: SessionConversationLedgerCoverage[]
  omitted: SessionConversationLedgerOmitted
  /** Workspaces whose records were cut at a cap; each is also incomplete in `coverage`. */
  truncatedWorktrees?: string[]
  folders: SessionConversationLedgerFolder[]
  projects: SessionConversationLedgerProject[]
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>
}

/**
 * A deletion the owner made (addendum F4, F15): the deleted conversation by EXACTLY ONE identity —
 * its full-claim digest, the pane identity of a provider-less conversation, or the anchor tab of a
 * workflow conversation (which has neither) — in its workspace, and when. Main authors every one
 * from the owner's durable deleted state; an undo clears it there, so the next set omits it. A
 * receiver matches one by `sessionConversationRemovalKey`.
 */
export type RuntimeSessionConversationRemoval = {
  /** `sessionConversationIdentity`: the deleted conversation's digest. */
  conversation?: string
  /** `pane:<paneKey>`: a conversation with no provider session. */
  paneIdentity?: string
  /** The workflow anchor tab on the owner (session-workflow-records.ts identity). */
  workflowTabId?: string
  worktreeId: string
  /** Epoch ms of the deletion. */
  at: number
}

/** The owner's whole ledger, ordered by its own generation and revision. */
export type RuntimeSessionConversationLedger = Omit<
  SessionConversationLedgerWindowPublication,
  'rendererGeneration'
> & {
  /** The owner runtime's incarnation; revisions order only within one. A new one removes nothing. */
  generation: string
  /** Monotonic within the generation: bumps on every change to the set, its coverage or removals. */
  revision: number
  /** `window`: the owner's window listed it; `main`: rebuilt from persistence (never removes). */
  source: SessionConversationLedgerSource
  /** The retained tombstones, from either source; each removes its row whatever the coverage. */
  removals: RuntimeSessionConversationRemoval[]
  /** Deletions were cut from `removals`: absence from it is no proof a conversation lives (F15). */
  removalsTruncated?: true
}

/**
 * A change to a set a stream already delivered: each changed workspace's whole list (`[]` when
 * none is left), replacing that bucket on any state at least as new as `baseRevision`. Folders and
 * projects ride only when they changed; absent means unchanged, never "none".
 */
export type RuntimeSessionConversationLedgerDelta = {
  generation: string
  revision: number
  baseRevision: number
  source: SessionConversationLedgerSource
  /** At least every changed workspace; a changed workspace it omits reads as incomplete. */
  coverage: SessionConversationLedgerCoverage[]
  changedByWorktree: Record<string, RuntimeSessionConversationRecord[]>
  folders?: SessionConversationLedgerFolder[]
  projects?: SessionConversationLedgerProject[]
  /** Every removal first published after `baseRevision`; absent means none. */
  removals?: RuntimeSessionConversationRemoval[]
  /** These removals are not all of them (cut at the cap): remove nothing by inference. */
  removalsTruncated?: true
}

/**
 * The conversation every computer calls the same: 24 hex chars of sha256 over the FULL owner claim
 * key (`getProviderSessionClaimKey`: worktreeId, agent, provider key and id, and the transcript
 * path for Pi and Prime Agent, whose conversations can share a session id across transcript
 * files). The path stays on the owner; only the digest crosses. A receiver computes the same digest
 * from its own record's claim key — a mirrored workspace reuses the owner's worktree id — so
 * folding and joining compare digests, never components. A capture whose digest matches no ledger
 * record but whose components (worktreeId, agent, provider key and id) match more than one record
 * is "ambiguous": it is kept separate and non-actionable, never merged into either. Null while no
 * provider session is known (the record then folds by its pane).
 */
export function sessionConversationIdentity(record: {
  worktreeId: string
  agent: string
  providerSession: AgentProviderSessionMetadata | null | undefined
}): string | null {
  const session = record.providerSession
  return session && record.agent && record.worktreeId
    ? sessionConversationIdentityFromClaimKey(
        getProviderSessionClaimKey({
          worktreeId: record.worktreeId,
          agent: record.agent,
          providerSession: session
        })
      )
    : null
}

/** The digest of an owner claim key a caller already holds (`getProviderSessionClaimKey`). */
export function sessionConversationIdentityFromClaimKey(claimKey: string): string {
  const bytes = new TextEncoder().encode(claimKey)
  return Array.from(sha256(bytes).subarray(0, IDENTITY_BYTES), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

/**
 * The identity (and its workspace) read off a sidebar provider key `[hostId, 'provider', claimKey]`
 * from any host: the digest of the full claim key, so the owner's `local` key and a peer's
 * `runtime:<id>` key for one conversation agree.
 */
export function sessionConversationIdentityFromProviderKey(
  folderKey: string
): { worktreeId: string; conversation: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(folderKey)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed[1] !== 'provider' || typeof parsed[2] !== 'string') {
    return null
  }
  const [worktreeId, agent, key, id] = parsed[2].split('\0')
  const known = (SESSION_CONVERSATION_PROVIDER_SESSION_KEYS as readonly string[]).includes(
    key ?? ''
  )
  return worktreeId && agent && known && id
    ? { worktreeId, conversation: sessionConversationIdentityFromClaimKey(parsed[2]) }
    : null
}

/** A wire `conversation` is exactly the digest shape; anything else reads as no identity. */
export function isSessionConversationIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)
}

export function sessionConversationPaneIdentity(paneKey: string): string {
  return `pane:${paneKey}`
}

/** What a record folds by: its conversation when known, else its pane (a read record has one). */
export function sessionConversationRecordIdentity(
  record: Pick<RuntimeSessionConversationRecord, 'conversation' | 'paneIdentity'>
): string {
  return record.conversation ?? record.paneIdentity ?? ''
}
