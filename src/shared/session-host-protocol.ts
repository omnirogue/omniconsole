/**
 * The Phase 4 wire contract: a Mac asks the host that runs a conversation to act on it; the host
 * checks policy, reserves the action, executes it and records the result. The same method names
 * serve paired runtimes (runtime RPC) and SSH relays (relay JSON-RPC); no stream opcode is added.
 * docs/reference/session-host-control.md.
 */

import type { SessionManageEntry, SessionTidyAction } from './session-manage-types'
import type { SessionHostOrigin } from './session-host-authority'
import type { OrganizationHistory } from './session-organization-change'
import {
  SESSION_CONTROL_DELIVERY_CAPABILITY,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_STATS_CAPABILITY,
  SESSION_ORGANIZATION_HOST_CAPABILITY,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CAPABILITY_BY_PROVIDER,
  SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  SESSION_WAITS_REMOTE_CAPABILITY,
  type SessionHostCapability,
  type SessionHostRelocationProvider
} from './session-host-capabilities'
import type {
  SessionHostIdentity,
  SessionHostProviderIdentity,
  SessionHostReservationState
} from './session-host-identity'
import type { SessionHostPayloads } from './session-host-payload-schema'
import type { SessionHostRefusal } from './session-host-refusal'
import type { SessionExecutionVerdict } from './session-host-verdict'

export const SESSION_HOST_RPC = {
  observe: 'sessionHost.observe',
  execute: 'sessionHost.execute',
  operation: 'sessionHost.operation',
  reserve: 'sessionHost.reserve',
  release: 'sessionHost.release',
  tidy: 'sessionHost.tidy',
  history: 'sessionHost.history',
  waitStatus: 'sessionHost.waitStatus',
  /** Relocation bundles (session-host-relocation-bundle.ts); also need that provider's relocation. */
  bundleRead: 'sessionHost.relocationBundleRead',
  bundleWrite: 'sessionHost.relocationBundleWrite',
  /** Read-only resource reading (session-host-stats.ts); never admitted, never journaled. */
  hostStats: 'sessionHost.hostStats'
} as const
export type SessionHostMethod = (typeof SESSION_HOST_RPC)[keyof typeof SESSION_HOST_RPC]

/** The capability a peer must have negotiated before a method is called (or answered). */
export const SESSION_HOST_METHOD_CAPABILITY: Record<SessionHostMethod, SessionHostCapability> = {
  [SESSION_HOST_RPC.observe]: SESSION_CONTROL_OWNER_CAPABILITY,
  [SESSION_HOST_RPC.execute]: SESSION_CONTROL_OWNER_CAPABILITY,
  [SESSION_HOST_RPC.operation]: SESSION_CONTROL_OWNER_CAPABILITY,
  [SESSION_HOST_RPC.reserve]: SESSION_CONTROL_OWNER_CAPABILITY,
  [SESSION_HOST_RPC.release]: SESSION_CONTROL_OWNER_CAPABILITY,
  [SESSION_HOST_RPC.tidy]: SESSION_ORGANIZATION_HOST_CAPABILITY,
  [SESSION_HOST_RPC.history]: SESSION_ORGANIZATION_HOST_CAPABILITY,
  [SESSION_HOST_RPC.waitStatus]: SESSION_WAITS_REMOTE_CAPABILITY,
  [SESSION_HOST_RPC.bundleRead]: SESSION_RELOCATION_BUNDLE_CAPABILITY,
  [SESSION_HOST_RPC.bundleWrite]: SESSION_RELOCATION_BUNDLE_CAPABILITY,
  [SESSION_HOST_RPC.hostStats]: SESSION_HOST_STATS_CAPABILITY
}

export type SessionHostAction = keyof SessionHostPayloads
export const SESSION_HOST_ACTIONS = [
  'continue',
  'ask',
  'answer',
  'stop',
  'restart',
  'rename',
  'archive',
  'unarchive',
  'organize',
  'undo',
  'transfer.prepare-source',
  'transfer.settle-source',
  'relocate.prepare-destination',
  'relocate.freeze-source',
  'relocate.export',
  'relocate.stage',
  'relocate.relinquish',
  'relocate.resume',
  'wait.register',
  'wait.cancel',
  'deliver'
] as const satisfies readonly SessionHostAction[]

/**
 * What an action is checked against before admission:
 * - `turn`: consumes the conversation's turn; different operation ids for one turn admit one.
 * - `organization`: checked against `expectedOrganizationRevision`, never blocks on a turn.
 * - `owner`: owner epoch only (stop must reach a session even while its turn is reserved).
 * - `destination`: a relocation destination that does not own the conversation yet.
 */
export type SessionHostFence = 'turn' | 'organization' | 'owner' | 'destination'
export type SessionHostFeature =
  | 'owner'
  | 'organization'
  | 'transfer'
  | 'relocation'
  | 'waits'
  | 'delivery'

export type SessionHostActionSpec = {
  feature: SessionHostFeature
  fence: SessionHostFence
  /** False: refused for any unattended caller, whatever the host's policy (D5; §5 relocation). */
  unattended: boolean
}

const spec = (feature: SessionHostFeature, fence: SessionHostFence, unattended = true) => ({
  feature,
  fence,
  unattended
})

export const SESSION_HOST_ACTION_SPECS: Record<SessionHostAction, SessionHostActionSpec> = {
  continue: spec('owner', 'turn'),
  ask: spec('owner', 'turn'),
  answer: spec('owner', 'turn'),
  stop: spec('owner', 'owner'),
  restart: spec('owner', 'turn'),
  rename: spec('organization', 'organization'),
  // Why turn-fenced: an archive must never race a continuation of the same turn.
  archive: spec('organization', 'turn'),
  unarchive: spec('organization', 'organization'),
  organize: spec('organization', 'organization'),
  undo: spec('organization', 'organization'),
  'transfer.prepare-source': spec('transfer', 'turn', false),
  'transfer.settle-source': spec('transfer', 'turn', false),
  'relocate.prepare-destination': spec('relocation', 'destination', false),
  'relocate.freeze-source': spec('relocation', 'turn', false),
  'relocate.export': spec('relocation', 'turn', false),
  'relocate.stage': spec('relocation', 'destination', false),
  'relocate.relinquish': spec('relocation', 'turn', false),
  'relocate.resume': spec('relocation', 'destination', false),
  'wait.register': spec('waits', 'owner'),
  'wait.cancel': spec('waits', 'owner'),
  // Why turn-fenced: a Mac's own queue or Keep going consumes the turn another Mac might continue.
  deliver: spec('delivery', 'turn')
}

/**
 * Whether finishing the action uses up the turn it was admitted on. An archive is turn-fenced only so
 * it never runs alongside a continuation; it sends the conversation nothing, so the same turn can
 * still be continued or answered once it is done.
 */
export function sessionHostActionConsumesTurn(action: SessionHostAction): boolean {
  const { feature, fence } = SESSION_HOST_ACTION_SPECS[action]
  return fence === 'turn' && feature !== 'organization'
}

const FEATURE_CAPABILITY: Record<
  Exclude<SessionHostFeature, 'relocation'>,
  SessionHostCapability
> = {
  owner: SESSION_CONTROL_OWNER_CAPABILITY,
  organization: SESSION_ORGANIZATION_HOST_CAPABILITY,
  transfer: SESSION_TRANSFER_REMOTE_SOURCE_CAPABILITY,
  waits: SESSION_WAITS_REMOTE_CAPABILITY,
  delivery: SESSION_CONTROL_DELIVERY_CAPABILITY
}

/** Relocation is negotiated per provider: only formats a host has tested are advertised. */
export function sessionHostActionCapability(
  action: SessionHostAction,
  provider?: SessionHostRelocationProvider
): SessionHostCapability | null {
  const { feature } = SESSION_HOST_ACTION_SPECS[action]
  if (feature === 'relocation') {
    return provider ? SESSION_RELOCATION_CAPABILITY_BY_PROVIDER[provider] : null
  }
  return FEATURE_CAPABILITY[feature]
}

/** `expectedTurnRevision` is null only when observe read no turn; `turn` actions then refuse. */
export type SessionHostRequest<A extends SessionHostAction = SessionHostAction> = {
  [K in A]: {
    operationId: string
    conversationId: string
    expectedOwnerEpoch: number
    expectedTurnRevision: string | null
    expectedOrganizationRevision?: string
    /** The op id of this caller's `reserve`, or of its earlier step whose reservation still holds. */
    reservation?: string
    origin: SessionHostOrigin
    action: K
    payload: SessionHostPayloads[K]
  }
}[A]

/**
 * An operation's recorded fate. `refused`: provably nothing delivered. `unconfirmed`: bytes may
 * have moved and the host cannot know; it is never resent and its reservation keeps blocking.
 */
export const SESSION_HOST_OPERATION_STATES = [
  'admitted',
  'dispatched',
  'completed',
  'refused',
  'unconfirmed'
] as const
export type SessionHostOperationState = (typeof SESSION_HOST_OPERATION_STATES)[number]

export type SessionHostOperationRecord = {
  operationId: string
  conversationId: string
  action: SessionHostAction
  state: SessionHostOperationState
  /** `sessionHostRequestFingerprint` at admission; a same-id request with another one refuses. */
  fingerprint: string
  host: SessionHostIdentity
  ownerEpoch: number
  turnRevision: string | null
  admittedAt?: number
  settledAt?: number
  refusal?: SessionHostRefusal
  /** Action-specific; present once `completed`. */
  result?: unknown
  /** The execution verdict when it settled. */
  verdict?: SessionExecutionVerdict
}

/**
 * `sessionHost.execute`, `.reserve` (an `admitted` record that holds the turn) and `.release`.
 * `refused` at this level is a gate refusal (capability, provenance, shape): nothing was
 * recorded. An admission decision always comes back as a recorded `operation`.
 */
export type SessionHostExecuteResult =
  | { status: 'ok'; operation: SessionHostOperationRecord }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostAdmissionStatus =
  | 'open'
  | 'reserved'
  | 'reconciling'
  | 'disabled'
  | 'not-adopted'

/** What `show` needs: the requesting Mac displays it; displaying never starts or resumes it. */
export type SessionHostSessionRef = {
  hostId: string
  conversationId: string
  paneKey: string | null
  tabId: string | null
  worktreePath: string | null
}

export type SessionHostObservation = {
  conversationId: string
  ownerEpoch: number
  turnRevision: string | null
  organizationRevision?: string
  verdict: SessionExecutionVerdict
  admission: SessionHostAdmissionStatus
  reservation?: {
    operationId: string
    action: SessionHostAction
    state: SessionHostReservationState
  }
  provider: SessionHostProviderIdentity | null
  ref: SessionHostSessionRef
  /** A presentation projection; never execution evidence. */
  entry?: SessionManageEntry
}

export type SessionHostObserveParams = { conversationIds?: string[]; includeArchived?: boolean }

/** Covers this host's registry only: an absent conversation is not evidence it stopped. */
export type SessionHostObserveResult =
  | {
      status: 'ok'
      host: SessionHostIdentity
      observedAt: number
      /** False while reconciling after a restart or while adoption is incomplete. */
      complete: boolean
      sessions: SessionHostObservation[]
    }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostOperationParams = { operationId: string; conversationId: string }

/** `found: false` from a reachable host is positive: its journal never admitted that id. */
export type SessionHostOperationResult =
  | { status: 'ok'; found: true; operation: SessionHostOperationRecord }
  | { status: 'ok'; found: false; host: SessionHostIdentity }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostReleaseParams = {
  operationId: string
  conversationId: string
  /** The reservation's own operation id; only a `held` one can be released. */
  reservation: string
  origin: SessionHostOrigin
}

/** Host-wide `session tidy`: each archive it applies is its own admitted, turn-fenced operation. */
export type SessionHostTidyParams = {
  operationId: string
  apply?: boolean
  /** Held conversations the person's request names; skip-class rows are never archived. */
  include?: string[]
  origin: SessionHostOrigin
}

export type SessionHostTidyRow = {
  conversationId: string | null
  title: string
  /** A host's tidy only archives; delete is this computer's own `session tidy --delete`. */
  action: Exclude<SessionTidyAction, 'delete'>
  reason: string
  /** Applied archives only. */
  operationId?: string
  outcome?: 'archived' | 'skipped' | 'failed'
  outcomeReason?: string
}

export type SessionHostTidyResult =
  | { status: 'ok'; host: SessionHostIdentity; dryRun: boolean; rows: SessionHostTidyRow[] }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostHistoryParams = { conversationId: string; limit?: number }
export type SessionHostHistoryResult =
  | { status: 'ok'; host: SessionHostIdentity; history: OrganizationHistory }
  | { status: 'refused'; refusal: SessionHostRefusal }

export type SessionHostWaitReceipt = {
  registration: string
  dependency: string
  state: 'registered' | 'satisfied' | 'cancelled' | 'ended-unmet'
  /** Only a satisfied wait carries these; a deadline or closed transport never does. */
  satisfiedBy?: { ownerEpoch: number; outcomeRevision: string; at: number }
}

export type SessionHostWaitStatusParams = { registration: string; dependency: string }
export type SessionHostWaitStatusResult =
  | { status: 'ok'; receipt: SessionHostWaitReceipt }
  | { status: 'refused'; refusal: SessionHostRefusal }
