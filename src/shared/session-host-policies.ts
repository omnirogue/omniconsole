/**
 * Automation overrides shared between this account's computers through the `t` document's `pol`
 * entries (Phase 4 E). Three kinds, by the entry's `d`:
 * - `<folderId>`: a folder (division) override; folder ids are the same on every Mac.
 * - `host:<hostId>`: a switch for one computer's host, set from any Mac.
 * - `ack:<hostId>`: that computer confirming the host switch it applied (same policy, same `at`).
 * Each override is one account-wide value: the newest entry from any Mac wins, so switching one
 * back on is a newer entry with an empty policy. An override only ever reduces autonomy against
 * the host's own default (automation or relocation off, lower caps); none can relax a hard stop.
 */

import {
  effectiveSessionHostFolderPolicy,
  SessionHostFolderPolicySchema,
  type SessionHostFolderPolicy,
  type SessionHostSyncEntry
} from './session-host-sync-doc'
import type { SessionHostControlSettings } from './session-host-control-settings'

export const HOST_POLICY_PREFIX = 'host:'
export const HOST_POLICY_ACK_PREFIX = 'ack:'

export type StampedPolicy = { p: SessionHostFolderPolicy; at: number }

export type SyncedHostPolicies = {
  folders: Record<string, StampedPolicy>
  hosts: Record<string, StampedPolicy>
  acks: Record<string, StampedPolicy>
}

export const EMPTY_SYNCED_HOST_POLICIES: SyncedHostPolicies = { folders: {}, hosts: {}, acks: {} }

type PolicyEntry = Extract<SessionHostSyncEntry, { k: 'pol' }>

function isPolicyEntry(entry: SessionHostSyncEntry): entry is PolicyEntry {
  return entry.k === 'pol'
}

/** The `pol` entries among every other computer's `t` entries, sorted into their three kinds. */
export function readSyncedHostPolicies(
  entries: readonly SessionHostSyncEntry[]
): SyncedHostPolicies {
  const synced: SyncedHostPolicies = { folders: {}, hosts: {}, acks: {} }
  for (const entry of entries.filter(isPolicyEntry)) {
    const parsed = SessionHostFolderPolicySchema.safeParse(entry.p)
    // Why off when unreadable: an override exists to reduce autonomy, so a bad one must not relax it.
    const p: SessionHostFolderPolicy = parsed.success
      ? effectiveSessionHostFolderPolicy(parsed.data)
      : { automation: 'off', relocation: 'off' }
    const stamped = { p, at: entry.at }
    const [bucket, key] = entry.d.startsWith(HOST_POLICY_PREFIX)
      ? (['hosts', entry.d.slice(HOST_POLICY_PREFIX.length)] as const)
      : entry.d.startsWith(HOST_POLICY_ACK_PREFIX)
        ? (['acks', entry.d.slice(HOST_POLICY_ACK_PREFIX.length)] as const)
        : (['folders', entry.d] as const)
    const known = synced[bucket][key]
    if (!known || entry.at > known.at) {
      synced[bucket][key] = stamped
    }
  }
  return synced
}

/** The account's value of one override: the newest entry, this Mac's own or another's. */
function newest(
  left: StampedPolicy | undefined,
  right: StampedPolicy | undefined
): StampedPolicy | undefined {
  return !left ? right : !right ? left : right.at > left.at ? right : left
}

/** Every override the account holds now, by published key, newest first-class. */
export function accountPolicies(
  local: Pick<SessionHostControlSettings, 'folderPolicies' | 'hostPolicies'>,
  published: Readonly<Record<string, StampedPolicy>>,
  synced: SyncedHostPolicies
): { folders: Record<string, SessionHostFolderPolicy>; hosts: Record<string, StampedPolicy> } {
  const localKeyed = publishedPolicyKeys(local)
  // Why local too: an override saved but not yet published is still this Mac's newest word.
  const mine = (key: string): StampedPolicy | undefined =>
    published[key] ?? (localKeyed[key] ? { p: localKeyed[key]!, at: -1 } : undefined)
  const folders: Record<string, SessionHostFolderPolicy> = {}
  const folderKeys = new Set(
    [...Object.keys(localKeyed), ...Object.keys(published), ...Object.keys(synced.folders)].filter(
      (key) => !key.startsWith(HOST_POLICY_PREFIX) && !key.startsWith(HOST_POLICY_ACK_PREFIX)
    )
  )
  for (const key of folderKeys) {
    const policy = newest(mine(key), synced.folders[key])?.p
    if (policy && Object.keys(policy).length > 0) {
      folders[key] = effectiveSessionHostFolderPolicy(policy)
    }
  }
  const hosts: Record<string, StampedPolicy> = {}
  const hostIds = new Set([
    ...Object.keys(synced.hosts),
    ...Object.keys(localKeyed)
      .concat(Object.keys(published))
      .filter((key) => key.startsWith(HOST_POLICY_PREFIX))
      .map((key) => key.slice(HOST_POLICY_PREFIX.length))
  ])
  for (const hostId of hostIds) {
    const value = newest(mine(`${HOST_POLICY_PREFIX}${hostId}`), synced.hosts[hostId])
    if (value) {
      hosts[hostId] = value
    }
  }
  return { folders, hosts }
}

/**
 * What this computer's host enforces: its own switches, with the account's folder overrides and
 * the account's switch for this host. Overrides only ever switch automation or relocation off (or
 * lower caps); an unreadable one reads as off, never as relaxed.
 */
export function effectiveSessionHostControl(
  local: SessionHostControlSettings,
  synced: SyncedHostPolicies,
  ownHostId: string | null,
  published: Readonly<Record<string, StampedPolicy>> = {}
): SessionHostControlSettings {
  const account = accountPolicies(local, published, synced)
  const hostOff = ownHostId !== null && account.hosts[ownHostId]?.p.automation === 'off'
  return {
    ...local,
    hostStewardship: local.hostStewardship && !hostOff,
    folderPolicies: account.folders
  }
}

function canonical(policy: SessionHostFolderPolicy): string {
  return JSON.stringify(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b)))
}

function samePolicy(left: SessionHostFolderPolicy, right: SessionHostFolderPolicy): boolean {
  return canonical(left) === canonical(right)
}

/** This computer's overrides, keyed as they are published (`<folderId>`, `host:<hostId>`). */
export function publishedPolicyKeys(
  local: Pick<SessionHostControlSettings, 'folderPolicies' | 'hostPolicies'>
): Record<string, SessionHostFolderPolicy> {
  const keyed: Record<string, SessionHostFolderPolicy> = {}
  for (const [folderId, policy] of Object.entries(local.folderPolicies)) {
    keyed[folderId] = policy
  }
  for (const [hostId, policy] of Object.entries(local.hostPolicies)) {
    keyed[`${HOST_POLICY_PREFIX}${hostId}`] = policy
  }
  return keyed
}

/**
 * The entries to publish for what changed since `published`: a new or changed override, and an
 * empty policy for one that was removed (a later entry is how "on again" reaches other Macs).
 */
export function policyEntriesToPublish(
  local: Record<string, SessionHostFolderPolicy>,
  published: Readonly<Record<string, StampedPolicy>>,
  now: number
): PolicyEntry[] {
  const entries: PolicyEntry[] = []
  for (const d of new Set([...Object.keys(local), ...Object.keys(published)])) {
    const next = local[d] ?? {}
    const previous = published[d]
    if (!previous || !samePolicy(previous.p, next)) {
      entries.push({ k: 'pol', d, p: next, at: now })
    }
  }
  return entries.filter((entry) => entry.d.length <= 64)
}

/** The acknowledgement this host owes for the host switch other Macs set on it, if any. */
export function hostPolicyAckToPublish(
  synced: SyncedHostPolicies,
  ownHostId: string,
  alreadyAcked: StampedPolicy | undefined
): PolicyEntry | null {
  const request = synced.hosts[ownHostId]
  if (!request || (alreadyAcked && alreadyAcked.at >= request.at)) {
    return null
  }
  return { k: 'pol', d: `${HOST_POLICY_ACK_PREFIX}${ownHostId}`, p: request.p, at: request.at }
}

/**
 * A switch this Mac set on another computer: `applied` once that computer's acknowledgement
 * covers it (same policy, at or after it), `pending` until then, however long it is unreachable.
 */
export function hostSwitchState(
  requested: StampedPolicy,
  ack: StampedPolicy | undefined
): 'applied' | 'pending' {
  return ack && ack.at >= requested.at && samePolicy(ack.p, requested.p) ? 'applied' : 'pending'
}
