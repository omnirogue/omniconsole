/**
 * Folder (division) and per-computer automation overrides between this account's Macs (Phase 4
 * E), carried as `pol` entries in each computer's own `t` documents. This Mac publishes what its
 * Settings changed, reads every other computer's overrides, applies them reduce-only to its own
 * host, and confirms a host switch set on it (`ack:<hostId>`) so the Mac that set it can stop
 * showing it pending. `<userData>/session-host/policies.json` keeps what was published and read.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  normalizeSessionHostControlSettings,
  type SessionHostControlSettings
} from '../../shared/session-host-control-settings'
import {
  accountPolicies,
  EMPTY_SYNCED_HOST_POLICIES,
  effectiveSessionHostControl,
  HOST_POLICY_PREFIX,
  hostPolicyAckToPublish,
  hostSwitchState,
  policyEntriesToPublish,
  publishedPolicyKeys,
  readSyncedHostPolicies,
  type StampedPolicy,
  type SyncedHostPolicies
} from '../../shared/session-host-policies'
import type {
  SessionHostFolderPolicy,
  SessionHostSyncEntry
} from '../../shared/session-host-sync-doc'
import type { HostSwitchReading } from '../../shared/session-hosts-status'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

type PolicySyncState = {
  published: Record<string, StampedPolicy>
  synced: SyncedHostPolicies
  acked?: StampedPolicy
}

export type SessionHostPolicySyncDeps = {
  file: string
  now: () => number
  publish: (entries: SessionHostSyncEntry[]) => void
  /** This computer's session host id; null until its host has opened. */
  ownHostId: () => string | null
}

function load(file: string): PolicySyncState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PolicySyncState>
    return {
      published: raw.published && typeof raw.published === 'object' ? raw.published : {},
      synced: raw.synced ?? EMPTY_SYNCED_HOST_POLICIES,
      ...(raw.acked ? { acked: raw.acked } : {})
    }
  } catch {
    // Why empty: nothing published yet means the next settings reading publishes it all.
    return { published: {}, synced: EMPTY_SYNCED_HOST_POLICIES }
  }
}

export class SessionHostPolicySync {
  private state: PolicySyncState
  private saving: Promise<void> = Promise.resolve()
  /** This Mac's own Settings as last read (the status reader has no store). */
  private local: unknown = undefined

  constructor(private readonly deps: SessionHostPolicySyncDeps) {
    this.state = load(deps.file)
  }

  synced(): SyncedHostPolicies {
    return this.state.synced
  }

  ownHostId(): string | null {
    return this.deps.ownHostId()
  }

  /** Publishes what changed in this Mac's own overrides since the last publish. */
  onSettings(raw: unknown): void {
    this.local = raw
    const local = normalizeSessionHostControlSettings(raw)
    const entries = policyEntriesToPublish(
      publishedPolicyKeys(local),
      this.state.published,
      this.deps.now()
    )
    if (entries.length === 0) {
      return
    }
    this.deps.publish(entries)
    for (const entry of entries) {
      this.state.published[entry.d] = { p: entry.p, at: entry.at }
    }
    this.save()
  }

  /** Every other computer's `t` entries, from each account sync pass. */
  ingest(entries: readonly SessionHostSyncEntry[]): void {
    this.state.synced = readSyncedHostPolicies(entries)
    const own = this.deps.ownHostId()
    const ack = own ? hostPolicyAckToPublish(this.state.synced, own, this.state.acked) : null
    if (ack) {
      this.deps.publish([ack])
      this.state.acked = { p: ack.p, at: ack.at }
    }
    this.save()
  }

  /** This host's switches as it enforces them: its own Settings, reduced by other Macs'. */
  effective(raw: unknown): SessionHostControlSettings {
    return effectiveSessionHostControl(
      normalizeSessionHostControlSettings(raw),
      this.state.synced,
      this.deps.ownHostId(),
      this.state.published
    )
  }

  /** The account's folder overrides now (this Mac's and every other's, newest each). */
  folderPolicies(): Record<string, SessionHostFolderPolicy> {
    return accountPolicies(
      normalizeSessionHostControlSettings(this.local),
      this.state.published,
      this.state.synced
    ).folders
  }

  /** The switch each other computer's host carries, and whether that computer confirmed it. */
  hostSwitches(): HostSwitchReading[] {
    const hostIds = new Set([
      ...Object.keys(this.state.synced.hosts),
      ...Object.keys(this.state.published)
        .filter((d) => d.startsWith(HOST_POLICY_PREFIX))
        .map((d) => d.slice(HOST_POLICY_PREFIX.length))
    ])
    return [...hostIds].flatMap((hostId): HostSwitchReading[] => {
      const mine = this.state.published[`${HOST_POLICY_PREFIX}${hostId}`]
      const theirs = this.state.synced.hosts[hostId]
      // Why the newest: a switch set later from another Mac supersedes this one's.
      const requested = !mine ? theirs : !theirs ? mine : theirs.at > mine.at ? theirs : mine
      return requested
        ? [
            {
              hostId,
              automation: requested.p.automation === 'off' ? 'off' : 'on',
              at: requested.at,
              state: hostSwitchState(requested, this.state.synced.acks[hostId]),
              setHere: requested === mine
            }
          ]
        : []
    })
  }

  private save(): void {
    const json = `${JSON.stringify(this.state)}\n`
    const { file } = this.deps
    this.saving = this.saving
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFileDurable(durableWriteTempPath(file), file, json))
      .catch((error: unknown) => {
        console.warn('[session-host] saving the synced automation overrides failed', error)
      })
  }

  flush(): Promise<void> {
    return this.saving
  }
}

let current: SessionHostPolicySync | null = null

export function getSessionHostPolicySync(): SessionHostPolicySync | null {
  return current
}

/** Main starts it once; the returned function stops it. */
export function startSessionHostPolicySync(
  input: Omit<SessionHostPolicySyncDeps, 'file'> & { userDataPath: string }
): SessionHostPolicySync {
  current = new SessionHostPolicySync({
    ...input,
    file: join(input.userDataPath, 'session-host', 'policies.json')
  })
  return current
}
