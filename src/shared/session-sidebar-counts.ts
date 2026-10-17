// What the Sessions sidebar last rendered (session-count fix, step 0): the per-host counts on the
// host switch, the Archived count, and the canonical (provider-deduplicated) conversation rows
// they were counted from. Read-only; the sampler compares these across computers.

import type { SessionFrameLogBuild } from './session-frame-log'
import type {
  SessionOwnerLedgerState,
  SessionParityBucketCounts,
  SessionParityFields,
  SessionParityPopulation
} from './session-parity'

export const UNKNOWN_SESSION_SIDEBAR_HOST = 'unknown'

/**
 * A counted row. Session parity (step 8) adds its bucket, verification, tagged identity, owner rest
 * and stale flag (session-parity.ts), the same fields `omni session list --json` reports; an older
 * window omits them.
 */
export type SessionSidebarCountsRow = Partial<SessionParityFields> & {
  /** conversationViewKey: the identity archive marks and folders are keyed by. */
  key: string
  rowKey: string
  /**
   * The host the per-host count attributed this row to (display host, else control host), or
   * `unknown` for a row whose host is not known, which no per-host count includes.
   */
  hostId: string
  worktreeId: string
  kind: 'terminal' | 'structured'
  agent: string
  paneKey: string | null
  providerSession: string | null
  archived: boolean
  unavailable: boolean
  launchPending: boolean
  workflow: boolean
  /** A workflow conversation's computer-independent identity (workspace + anchor tab), step 9. */
  workflowIdentity?: string
  /** Shown as "can't verify" (A4): counted, but its owner has not vouched for it. */
  ownershipUnverified?: string
  label: string
}

/**
 * Session parity (step 8) splits `count` by bucket: count = ownerListed + heldByOwner +
 * receiverOnly + workflow (+ `background`, terminals the switch counts with no row); unverified,
 * stale and archived are counted within it. An older window sends only the count.
 */
export type SessionSidebarHostCount = {
  hostId: string
  label: string | null
  count: number
} & Partial<SessionParityBucketCounts & { background: number }>

export type SessionSidebarHostAvailability = {
  hostId: string
  label: string | null
  kind: string | null
  /** The health the sidebar's host switch shows for this host. */
  health: string | null
  connectionStatus: string | null
  /** Paired runtimes only; null: never probed in this window. */
  reachable: boolean | null
  graphStatus: string | null
  appVersion: string | null
  checkedAt: number | null
}

export type SessionSidebarCountsResult = {
  /** True only while the Sessions sidebar is on screen and this window has restored its sessions. */
  available: boolean
  reason?: string
  /** Whether the sidebar is mounted right now (switching the panel to Goals or Team unmounts it). */
  onScreen: boolean
  /** workspaceSessionReady in this window; null when the sidebar is not on screen. */
  ready: boolean | null
  /** When the sidebar last published these counts, and when this read was answered. */
  renderedAt: number | null
  readAt: number
  /** The host switch's own rows: every host it lists, with the count it shows (zeros included). */
  switchHostCounts: SessionSidebarHostCount[]
  /** Sessions per host as counted, only hosts that have at least one (may include hosts the switch omits). */
  sessionCountsByHost: SessionSidebarHostCount[]
  archivedCount: number | null
  hiddenCount: number | null
  showArchived: boolean | null
  hostFilter: unknown
  rows: SessionSidebarCountsRow[]
  /**
   * Rows with no known host (step 9): listed with Home but never counted as this computer's; they
   * appear in `sessionCountsByHost` under `unknown`, so Home's list = `local` + `unknown`.
   */
  unknownHostCount?: number
  archiveKeys: string[]
  hosts: SessionSidebarHostAvailability[]
  /** G2: every paired owner's conversation ledger as this window knows it; older windows omit it. */
  ownerLedgers?: SessionOwnerLedgerState[]
  /**
   * C5: the UNFILTERED canonical parity population (every row before tag, agent and routine
   * filters), identical to `omni session list --json`'s. Sent whenever this window has restored its
   * sessions, even with the sidebar off screen; older windows omit it.
   */
  parity?: SessionParityPopulation
  /** Stamped by main: the build this window runs. */
  build?: SessionFrameLogBuild
}

/** The shape every unavailable answer takes: no counts, so nothing reads as real zeros. */
export function unavailableSessionSidebarCounts(
  reason: string,
  fields: { onScreen?: boolean; ready?: boolean | null; renderedAt?: number | null } = {}
): SessionSidebarCountsResult {
  return {
    available: false,
    reason,
    onScreen: fields.onScreen ?? false,
    ready: fields.ready ?? null,
    renderedAt: fields.renderedAt ?? null,
    readAt: Date.now(),
    switchHostCounts: [],
    sessionCountsByHost: [],
    archivedCount: null,
    hiddenCount: null,
    showArchived: null,
    hostFilter: null,
    rows: [],
    archiveKeys: [],
    hosts: []
  }
}
