/**
 * What this Mac knows about the other computers that run its sessions (Phase 4 E), as the Work
 * card, `omni session hosts` and Settings read it. One reading per host, never one per session.
 */

import {
  SESSION_HOST_RELOCATION_PROVIDERS,
  SESSION_RELOCATION_BUNDLE_CAPABILITY,
  SESSION_RELOCATION_CAPABILITY_BY_PROVIDER,
  type SessionHostRelocationProvider
} from './session-host-capabilities'
import type { SessionExecutionVerdict } from './session-manage-types'
import type { SessionHostFolderPolicy } from './session-host-sync-doc'
import type { SessionOwnerLedgerState } from './session-parity'

export const SESSION_HOSTS_RPC = {
  status: 'sessionHosts.status',
  archive: 'sessionHosts.archive',
  /** Window-only: the durable receiver snapshots of paired owners' ledgers (session parity). */
  ledgerSnapshots: 'sessionHosts.ledgerSnapshots'
} as const

export type SessionHostArchiveResult =
  | { status: 'completed' }
  | { status: 'pending'; operationId: string }

/**
 * - `checking`: not read yet.
 * - `unreachable`: it could not be asked, or did not answer; its sessions are left alone.
 * - `older`: its OmniConsole has no session host control; controls are refused before sending.
 * - `controls-off`: it offers no controls this Mac understands (switched off there, or none yet).
 * - `ready`: it carries out controls on its own sessions.
 */
export const REMOTE_HOST_STATES = [
  'checking',
  'unreachable',
  'older',
  'controls-off',
  'ready'
] as const
export type RemoteHostState = (typeof REMOTE_HOST_STATES)[number]

export type RemoteHostCounts = Record<SessionExecutionVerdict, number> & {
  total: number
  working: number
  /** Asking its person something, or waiting for a yes. */
  needsYou: number
  stalled: number
}

export const EMPTY_REMOTE_HOST_COUNTS: RemoteHostCounts = {
  total: 0,
  live: 0,
  exited: 0,
  unverifiable: 0,
  working: 0,
  needsYou: 0,
  stalled: 0
}

export type RemoteHostSnapshot = {
  /** The execution host key rows carry: `runtime:<environment>` or `ssh:<target>`. */
  hostKey: string
  kind: 'runtime' | 'ssh'
  state: RemoteHostState
  /** The host's own words, or why it could not be read. */
  detail?: string
  /** Its session host registry id, once it advertised one. */
  hostId?: string
  /** Capabilities both sides agreed on the last reading. */
  capabilities: string[]
  checkedAt: number | null
  /** Only when it answered `observe`; null otherwise (never shown as zero sessions). */
  counts: RemoteHostCounts | null
  /**
   * Session parity (G2): a paired owner's conversation ledger as this computer knows it — ready,
   * stale ("as of"), older or unreachable. Absent when none was ever heard, or from an older host.
   */
  ledger?: SessionOwnerLedgerState
}

/** An automation switch set on another computer's host, from any of this account's Macs. */
export type HostSwitchReading = {
  /** That computer's session host registry id. */
  hostId: string
  automation: 'on' | 'off'
  at: number
  /** `pending` until that computer confirms it applied exactly this (it may be unreachable). */
  state: 'applied' | 'pending'
  /** This Mac set it (otherwise another Mac did, later). */
  setHere: boolean
}

export type SessionHostsStatusResult = {
  hosts: RemoteHostSnapshot[]
  /** A reading of stale hosts started with this call; the next poll shows it. */
  refreshing: boolean
  switches: HostSwitchReading[]
  /** The account's folder overrides now, from any Mac (the newest of each applies everywhere). */
  folderPolicies: Record<string, SessionHostFolderPolicy>
  /** Another Mac switched automatic actions off on this computer's host. */
  thisHostOffElsewhere: boolean
}

/**
 * Which providers' conversations can be moved to or from this computer (`omni session relocate`):
 * both that provider's relocation and moving bundles were agreed. Empty for a host whose
 * OmniConsole cannot move conversations, which keeps the not-available wording below.
 */
export function relocatableProviders(
  capabilities: readonly string[]
): SessionHostRelocationProvider[] {
  return capabilities.includes(SESSION_RELOCATION_BUNDLE_CAPABILITY)
    ? SESSION_HOST_RELOCATION_PROVIDERS.filter((provider) =>
        capabilities.includes(SESSION_RELOCATION_CAPABILITY_BY_PROVIDER[provider])
      )
    : []
}

/** Said only for a computer that cannot take a moved conversation. */
export const CROSS_COMPUTER_RELOCATION_UNAVAILABLE =
  'Its OmniConsole cannot move conversations yet; hand the work off instead (omni session handoff), or update OmniConsole there.'
